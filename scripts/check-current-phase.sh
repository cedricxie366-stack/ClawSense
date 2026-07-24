#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="$ROOT_DIR/.local/current-phase-reports"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT_JSON="$REPORT_DIR/current-phase-$TS.json"
REPORT_LOG="$REPORT_DIR/current-phase-$TS.log"
ACCEPTANCE_OUT="$REPORT_DIR/acceptance-$TS.out"
EVIDENCE_OUT="$REPORT_DIR/video-evidence-$TS.out"
PHASE9_OUT="$REPORT_DIR/phase9-$TS.out"
PUBLIC_REPLAY_OUT="$REPORT_DIR/public-ami-replay-$TS.out"
ADB_OUT="$REPORT_DIR/adb-devices-$TS.out"

mkdir -p "$REPORT_DIR"
cd "$ROOT_DIR"

log() {
  printf '[check:phase] %s\n' "$*" | tee -a "$REPORT_LOG"
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  perl -e '
use strict;
use warnings;
my $timeout = shift @ARGV;
my $pid = fork();
die "fork failed: $!" unless defined $pid;
if ($pid == 0) {
  setpgrp(0, 0);
  exec @ARGV;
  die "exec failed: $!";
}
local $SIG{ALRM} = sub {
  kill "TERM", -$pid;
  sleep 2;
  kill "KILL", -$pid;
  exit 124;
};
alarm $timeout;
waitpid($pid, 0);
my $status = $?;
alarm 0;
exit 1 if $status == -1;
exit(128 + ($status & 127)) if $status & 127;
exit($status >> 8);
' "$timeout_seconds" "$@"
}

run_logged() {
  log "run: $*"
  run_with_timeout "${PHASE_COMMAND_TIMEOUT_SECONDS:-600}" "$@" 2>&1 | tee -a "$REPORT_LOG"
}

capture_logged() {
  local out="$1"
  shift
  local timeout_seconds="${PHASE_COMMAND_TIMEOUT_SECONDS:-600}"
  if [[ "${1:-}" == "--timeout" ]]; then
    timeout_seconds="$2"
    shift 2
  fi
  log "run: $*"
  run_with_timeout "$timeout_seconds" "$@" >"$out" 2>&1
  cat "$out" | tee -a "$REPORT_LOG"
}

log "repo=$ROOT_DIR"
log "report=$REPORT_JSON"

export CHECK_ANDROID="${CHECK_ANDROID:-1}"
run_logged npm run check:release

if [[ "${SYNC_LOCAL_OPENCLAW:-1}" == "1" ]]; then
  log "syncing repo-local OpenClaw runtime with current worktree"
  run_logged bash scripts/local-openclaw.sh setup
elif [[ ! -x "$ROOT_DIR/.local/openclaw/home/node_modules/.bin/openclaw" ]]; then
  log "local OpenClaw runtime missing; running repo-local setup"
  run_logged bash scripts/local-openclaw.sh setup
else
  log "skipping repo-local setup because SYNC_LOCAL_OPENCLAW=0"
fi

PUBLIC_REPLAY_DATE="$(date +%F)"
export CLAWSENSE_PUBLIC_AMI_REPLAY_DATE="$PUBLIC_REPLAY_DATE"
capture_logged "$PUBLIC_REPLAY_OUT" npm run check:public-replay
LEGACY_AMI_FIXTURE_WAV="$ROOT_DIR/.local/test-fixtures/ami-es2002a/raw/ES2002a.Mix-Headset.wav"
if [[ -f "$LEGACY_AMI_FIXTURE_WAV" ]]; then
run_logged node scripts/replay-ami-fixture.mjs --reset --force
else
  log "skip legacy AMI fixture replay; missing $LEGACY_AMI_FIXTURE_WAV and public AMI replay already passed"
fi
run_logged node scripts/replay-mit-lecture-fixture.mjs --reset --force
run_logged node scripts/replay-mit-lecture-video-fixture.mjs --reset --force
run_logged bash scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '"keyframes"' --strict-json

if [[ -f "$LEGACY_AMI_FIXTURE_WAV" ]]; then
  log "run: annotate AMI fixture speaker smoke"
  node <<'NODE' 2>&1 | tee -a "$REPORT_LOG"
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const state = JSON.parse(fs.readFileSync(".local/openclaw/state/plugins/clawsense/state.json", "utf8"));
const event = (state.events || []).find(
  (candidate) => candidate.modality === "audio" && String(candidate.note || "").includes("fixture=ami-es2002a"),
);
if (!event) {
  throw new Error("ami_fixture_audio_event_missing");
}
const session = String(event.note || "").match(/\bsession=([^\s]+)/)?.[1];
if (!session) {
  throw new Error("ami_fixture_session_missing");
}
const windowId = `audio-session::${event.deviceId}::${session}`;
const speakerRef = `speaker:${windowId}:1`;
const args = [
  "scripts/local-openclaw.sh",
  "openclaw",
  "clawsense",
  "annotate-speaker",
  speakerRef,
  "Laura (fixture)",
  "--relationship",
  "project manager",
  "--notes",
  "Current phase automated speaker annotation smoke.",
  "--windowId",
  windowId,
];
const result = spawnSync("bash", args, { encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
NODE
else
  log "skip legacy AMI speaker smoke; public AMI replay already validated speaker annotation"
fi

capture_logged "$ACCEPTANCE_OUT" bash scripts/local-openclaw.sh acceptance
capture_logged "$EVIDENCE_OUT" --timeout "${PHASE_EVIDENCE_TIMEOUT_SECONDS:-120}" bash scripts/local-openclaw.sh openclaw clawsense evidence --lookbackDays 7 --modality video --focus what_happened --question "这段视频里老师讲了什么重点？"
capture_logged "$PHASE9_OUT" npm run check:phase9

if command -v adb >/dev/null 2>&1; then
  capture_logged "$ADB_OUT" adb devices -l
else
  printf 'adb_not_found\n' >"$ADB_OUT"
  cat "$ADB_OUT" | tee -a "$REPORT_LOG"
fi

REQUIRE_ANDROID_DEVICE="${REQUIRE_ANDROID_DEVICE:-0}" \
PUBLIC_REPLAY_EXPECTED_DATE="$PUBLIC_REPLAY_DATE" \
REPORT_JSON="$REPORT_JSON" \
ACCEPTANCE_OUT="$ACCEPTANCE_OUT" \
EVIDENCE_OUT="$EVIDENCE_OUT" \
PHASE9_OUT="$PHASE9_OUT" \
PUBLIC_REPLAY_OUT="$PUBLIC_REPLAY_OUT" \
ADB_OUT="$ADB_OUT" \
node <<'NODE'
const fs = require("node:fs");

function extractJson(raw, label) {
  const candidates = [];
  for (let start = 0; start < raw.length; start += 1) {
    const first = raw[start];
    if (first !== "{" && first !== "[") continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const ch = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push(ch);
        continue;
      }
      if (ch === "}" || ch === "]") {
        const open = stack.pop();
        if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) {
          break;
        }
        if (stack.length === 0) {
          const segment = raw.slice(start, index + 1);
          try {
            candidates.push(JSON.parse(segment));
          } catch {
            // Keep looking. CLI banners can contain JSON-looking fragments.
          }
          break;
        }
      }
    }
  }
  const predicate =
    label === "acceptance"
      ? (candidate) => candidate?.completion && Array.isArray(candidate?.criteria)
      : label === "video-evidence"
        ? (candidate) => candidate?.ok === true && candidate?.evidenceBundle
        : label === "phase9"
          ? (candidate) => candidate?.ok === true && candidate?.phase9
          : label === "public-replay"
            ? (candidate) => candidate?.ok === true && candidate?.replay && candidate?.before && candidate?.after
          : (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const object = candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && predicate(candidate));
  if (!object) {
    throw new Error(`unable_to_parse_json_output:${label}`);
  }
  return object;
}

function countAdbDevices(raw) {
  if (raw.includes("adb_not_found")) return { adbAvailable: false, devices: [] };
  const devices = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .filter((line) => /\bdevice\b/.test(line) && !/\bunauthorized\b|\boffline\b/.test(line));
  return { adbAvailable: true, devices };
}

function requireNumberAtLeast(value, expected, label) {
  if (!Number.isFinite(value) || value < expected) {
    throw new Error(`${label}:expected>=${expected}:actual=${value}`);
  }
}

const acceptanceRaw = fs.readFileSync(process.env.ACCEPTANCE_OUT, "utf8");
const evidenceRaw = fs.readFileSync(process.env.EVIDENCE_OUT, "utf8");
const phase9Raw = fs.readFileSync(process.env.PHASE9_OUT, "utf8");
const publicReplayRaw = fs.readFileSync(process.env.PUBLIC_REPLAY_OUT, "utf8");
const adbRaw = fs.readFileSync(process.env.ADB_OUT, "utf8");
const acceptance = extractJson(acceptanceRaw, "acceptance");
const evidence = extractJson(evidenceRaw, "video-evidence");
const phase9 = extractJson(phase9Raw, "phase9");
const publicReplay = extractJson(publicReplayRaw, "public-replay");
const adb = countAdbDevices(adbRaw);
const requireAndroidDevice = process.env.REQUIRE_ANDROID_DEVICE === "1";

if (acceptance.completion?.phaseState !== "ready-to-close") {
  throw new Error(`acceptance_not_ready:${acceptance.completion?.phaseState ?? "<missing>"}`);
}
if (acceptance.completion?.passedCriteria !== acceptance.completion?.totalCriteria) {
  throw new Error(
    `acceptance_incomplete:${acceptance.completion?.passedCriteria}/${acceptance.completion?.totalCriteria}`,
  );
}
if (Array.isArray(acceptance.completion?.blockers) && acceptance.completion.blockers.length > 0) {
  throw new Error(`acceptance_has_blockers:${acceptance.completion.blockers.join("|")}`);
}
const videoCriterion = (acceptance.criteria || []).find((criterion) => criterion.id === "video-evidence");
if (!videoCriterion || videoCriterion.status !== "pass") {
  throw new Error(`video_acceptance_not_pass:${videoCriterion?.status ?? "<missing>"}`);
}
if (videoCriterion.evidence?.hostModelVideoMode !== "keyframes") {
  throw new Error(`video_mode_not_keyframes:${videoCriterion.evidence?.hostModelVideoMode ?? "<missing>"}`);
}
requireNumberAtLeast(videoCriterion.evidence?.playableVideoArtifacts, 1, "playableVideoArtifacts");
requireNumberAtLeast(videoCriterion.evidence?.videoRequestGroups, 1, "videoRequestGroups");
requireNumberAtLeast(videoCriterion.evidence?.keyframeEvents, 1, "keyframeEvents");

if (evidence.ok !== true) {
  throw new Error("video_evidence_not_ok");
}
requireNumberAtLeast(evidence.evidenceBundle?.audioCoverage?.transcriptReadyWindows, 1, "transcriptReadyWindows");
requireNumberAtLeast(evidence.evidenceBundle?.videoCoverage?.groupsWithVideoArtifacts, 1, "groupsWithVideoArtifacts");
requireNumberAtLeast(evidence.evidenceBundle?.videoCoverage?.groupsWithKeyframes, 1, "groupsWithKeyframes");
requireNumberAtLeast(evidence.evidenceBundle?.transcriptSpans?.length, 1, "transcriptSpans");
requireNumberAtLeast(evidence.evidenceBundle?.videoEvidenceGroups?.length, 1, "videoEvidenceGroups");
requireNumberAtLeast(evidence.evidenceBundle?.videoEvidenceGroups?.[0]?.transcriptSpans?.length, 1, "videoGroupTranscriptSpans");
requireNumberAtLeast(
  evidence.evidenceBundle?.videoEvidenceGroups?.[0]?.keyframeDetails?.length,
  1,
  "videoGroupKeyframeDetails",
);

if (phase9.ok !== true || !phase9.phase9) {
  throw new Error("phase9_not_ok");
}
for (const group of ["autoVideoTrigger", "host", "android", "liveReport"]) {
  const checks = phase9.phase9[group];
  if (!checks || typeof checks !== "object") {
    throw new Error(`phase9_group_missing:${group}`);
  }
  for (const [key, value] of Object.entries(checks)) {
    if (value !== true) {
      throw new Error(`phase9_check_failed:${group}.${key}`);
    }
  }
}

if (publicReplay.ok !== true) {
  throw new Error("public_replay_not_ok");
}
const publicReplayExpectedDate = process.env.PUBLIC_REPLAY_EXPECTED_DATE || "2026-01-15";
if (publicReplay.replay?.fixtureDate !== publicReplayExpectedDate) {
  throw new Error(`public_replay_unexpected_fixture_date:${publicReplay.replay?.fixtureDate ?? "<missing>"}`);
}
requireNumberAtLeast(publicReplay.replay?.segmentCount, 12, "publicReplaySegmentCount");
requireNumberAtLeast(publicReplay.before?.transcriptSpanCount, 10, "publicReplayBeforeTranscriptSpans");
requireNumberAtLeast(publicReplay.before?.topicSegmentCount, 1, "publicReplayBeforeTopicSegments");
requireNumberAtLeast(publicReplay.before?.evidenceFollowUpTargetCount, 1, "publicReplayBeforeFollowups");
requireNumberAtLeast(publicReplay.after?.transcriptSpanCount, 10, "publicReplayAfterTranscriptSpans");
requireNumberAtLeast(publicReplay.after?.evidenceFollowUpTargetCount, 1, "publicReplayAfterFollowups");
if (publicReplay.annotation?.displayName !== "Sarah") {
  throw new Error(`public_replay_annotation_missing:${publicReplay.annotation?.displayName ?? "<missing>"}`);
}

if (requireAndroidDevice && adb.devices.length === 0) {
  throw new Error("android_device_required_but_missing");
}

const summary = {
  ok: true,
  generatedAt: Date.now(),
  acceptance: {
    phaseState: acceptance.completion.phaseState,
    passedCriteria: acceptance.completion.passedCriteria,
    totalCriteria: acceptance.completion.totalCriteria,
    progressPct: acceptance.completion.progressPct,
  },
  videoAcceptance: {
    hostModelVideoMode: videoCriterion.evidence.hostModelVideoMode,
    playableVideoArtifacts: videoCriterion.evidence.playableVideoArtifacts,
    videoRequestGroups: videoCriterion.evidence.videoRequestGroups,
    keyframeEvents: videoCriterion.evidence.keyframeEvents,
  },
  videoEvidence: {
    transcriptReadyWindows: evidence.evidenceBundle.audioCoverage.transcriptReadyWindows,
    videoGroups: evidence.evidenceBundle.videoEvidenceGroups.length,
    transcriptSpans: evidence.evidenceBundle.transcriptSpans.length,
    keyframeDetails: evidence.evidenceBundle.videoEvidenceGroups[0].keyframeDetails.length,
  },
  phase9: {
    autoVideoTriggerChecks: Object.keys(phase9.phase9.autoVideoTrigger).length,
    hostChecks: Object.keys(phase9.phase9.host).length,
    androidChecks: Object.keys(phase9.phase9.android).length,
    liveReportChecks: Object.keys(phase9.phase9.liveReport).length,
  },
  publicReplay: {
    fixtureDate: publicReplay.replay.fixtureDate,
    segmentCount: publicReplay.replay.segmentCount,
    transcriptSpans: publicReplay.before.transcriptSpanCount,
    topicSegments: publicReplay.before.topicSegmentCount,
    evidenceFollowUpTargets: publicReplay.before.evidenceFollowUpTargetCount,
    annotatedSpeaker: publicReplay.annotation.displayName,
  },
  android: {
    adbAvailable: adb.adbAvailable,
    connectedDevices: adb.devices.length,
    requireAndroidDevice,
    status: adb.devices.length > 0 ? "device-connected" : "device-missing",
  },
};

fs.writeFileSync(process.env.REPORT_JSON, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

log "ok"
