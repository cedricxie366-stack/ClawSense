#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FIXTURE_REPORT_DIR="$TMP_DIR/stage-final-reports"
FIXTURE_ANDROID_LIVE_DIR="$TMP_DIR/android-live-reports"

cd "$ROOT_DIR"

log() {
  printf '[check:stage-final:fixtures] %s\n' "$*"
}

write_phase() {
  local path="$1"
  local generated_at="$2"
  cat >"$path" <<JSON
{
  "ok": true,
  "generatedAt": $generated_at,
  "acceptance": {
    "phaseState": "ready-to-close",
    "passedCriteria": 5,
    "totalCriteria": 5
  },
  "videoAcceptance": {
    "hostModelVideoMode": "keyframes",
    "playableVideoArtifacts": 1,
    "videoRequestGroups": 1
  },
  "videoEvidence": {
    "transcriptSpans": 1,
    "keyframeDetails": 1
  }
}
JSON
}

write_live() {
  local path="$1"
  local generated_at="$2"
  cat >"$path" <<JSON
{
  "ok": true,
  "generatedAt": $generated_at,
  "verdict": {
    "physicalAndroidDevice": true,
    "hostDeviceSeen": true,
    "voiceLoopObserved": true,
    "ttsStatus": "pass",
    "humanTtsOk": true,
    "humanAnswerRelevant": true,
    "stopTtsObserved": true,
    "videoStatus": "upload-observed",
    "authStable": true,
    "phaseReadyForRelease": true
  },
  "logs": {
    "assistantQueryAnswered": 1,
    "assistantTtsCompleted": 1,
    "videoUploadSucceeded": 1
  },
  "host": {
    "videoEvidenceGroups": 1,
    "videoTranscriptSpans": 1,
    "videoKeyframeDetails": 1
  },
  "androidDevice": {
    "serial": "fixture-physical",
    "manufacturer": "Fixture",
    "model": "Physical",
    "isEmulator": false
  },
  "androidPackage": {
    "packageName": "ai.openclaw.clawsense.debug",
    "versionName": "fixture",
    "versionCode": 1
  }
}
JSON
}

write_no_arm() {
  local path="$1"
  local generated_at="$2"
  cat >"$path" <<JSON
{
  "ok": true,
  "generatedAt": $generated_at,
  "verdict": {
    "expectsNoAssistantQuery": true,
    "noArmAmbientQueryClean": true,
    "noArmAmbientQueryPollution": false
  },
  "logs": {
    "assistantQueryArmed": 0,
    "assistantQueryCaptured": 0,
    "assistantQuerySubmitting": 0,
    "assistantQueryAnswered": 0,
    "audioUploadSucceeded": 1
  }
}
JSON
}

write_auto_video() {
  local path="$1"
  local generated_at="$2"
  cat >"$path" <<JSON
{
  "ok": true,
  "generatedAt": $generated_at,
  "verdict": {
    "physicalAndroidDevice": true,
    "hostDeviceSeen": true,
    "expectsAutoVideo": true,
    "videoStatus": "upload-observed",
    "authStable": true,
    "autoVideoObserved": true,
    "autoVideoThrottled": false,
    "autoVideoLiveReady": true,
    "phaseReadyForRelease": false
  },
  "logs": {
    "autoVideoCaptureRequested": 1,
    "autoVideoUploadSucceeded": 1,
    "videoUploadSucceeded": 1
  },
  "host": {
    "videoEvidenceGroups": 1,
    "videoTranscriptSpans": 0,
    "videoKeyframeDetails": 1
  },
  "androidDevice": {
    "serial": "fixture-physical",
    "manufacturer": "Fixture",
    "model": "Physical",
    "isEmulator": false
  },
  "androidPackage": {
    "packageName": "ai.openclaw.clawsense.debug",
    "versionName": "fixture",
    "versionCode": 1
  }
}
JSON
}

expect_success() {
  local name="$1"
  shift
  local out="$TMP_DIR/$name.out"
  log "expect success: $name"
  if ! "$@" >"$out" 2>&1; then
    cat "$out"
    log "FAILED: expected success for $name"
    exit 1
  fi
  if ! rg '"ok": true' "$out" >/dev/null; then
    cat "$out"
    log "FAILED: expected ok=true in $name output"
    exit 1
  fi
}

expect_failure_contains() {
  local name="$1"
  local pattern="$2"
  shift 2
  local out="$TMP_DIR/$name.out"
  log "expect failure: $name -> $pattern"
  set +e
  "$@" >"$out" 2>&1
  local code=$?
  set -e
  if [[ "$code" == "0" ]]; then
    cat "$out"
    log "FAILED: expected failure for $name"
    exit 1
  fi
  if ! rg "$pattern" "$out" >/dev/null; then
    cat "$out"
    log "FAILED: expected pattern '$pattern' in $name output"
    exit 1
  fi
}

PHASE_READY="$TMP_DIR/phase-ready.json"
LIVE_FRESH="$TMP_DIR/live-fresh.json"
LIVE_STALE="$TMP_DIR/live-stale.json"
LIVE_MISSING="$TMP_DIR/live-missing.json"
LIVE_EMULATOR="$TMP_DIR/live-emulator.json"
LIVE_NO_HUMAN="$TMP_DIR/live-no-human.json"
LIVE_AUTH_FAILURE="$TMP_DIR/live-auth-failure.json"
NO_ARM_FRESH="$TMP_DIR/no-arm-fresh.json"
NO_ARM_STALE="$TMP_DIR/no-arm-stale.json"
NO_ARM_POLLUTED="$TMP_DIR/no-arm-polluted.json"
NO_ARM_MISSING="$TMP_DIR/no-arm-missing.json"
AUTO_VIDEO_FRESH="$TMP_DIR/auto-video-fresh.json"
AUTO_VIDEO_STALE="$TMP_DIR/auto-video-stale.json"
AUTO_LIVE_FRESH="$FIXTURE_ANDROID_LIVE_DIR/android-live-20260531-120000.json"
AUTO_NO_ARM_NEWER="$FIXTURE_ANDROID_LIVE_DIR/android-live-20260531-120100.json"
AUTO_VIDEO_NEWER="$FIXTURE_ANDROID_LIVE_DIR/android-live-20260531-120200.json"

mkdir -p "$FIXTURE_ANDROID_LIVE_DIR"
write_phase "$PHASE_READY" 2000
write_live "$LIVE_FRESH" 3000
write_live "$LIVE_STALE" 1000
write_no_arm "$NO_ARM_FRESH" 3100
write_no_arm "$NO_ARM_STALE" 1000
write_no_arm "$NO_ARM_POLLUTED" 3200
write_auto_video "$AUTO_VIDEO_FRESH" 3300
write_auto_video "$AUTO_VIDEO_STALE" 1000
cp "$LIVE_FRESH" "$AUTO_LIVE_FRESH"
cp "$NO_ARM_FRESH" "$AUTO_NO_ARM_NEWER"
cp "$AUTO_VIDEO_FRESH" "$AUTO_VIDEO_NEWER"
cp "$LIVE_FRESH" "$LIVE_EMULATOR"
cp "$LIVE_FRESH" "$LIVE_NO_HUMAN"
cp "$LIVE_FRESH" "$LIVE_AUTH_FAILURE"

LIVE_EMULATOR="$LIVE_EMULATOR" LIVE_NO_HUMAN="$LIVE_NO_HUMAN" LIVE_AUTH_FAILURE="$LIVE_AUTH_FAILURE" NO_ARM_POLLUTED="$NO_ARM_POLLUTED" node <<'NODE'
const fs = require("node:fs");

function mutate(path, fn) {
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  fn(value);
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

mutate(process.env.LIVE_EMULATOR, (live) => {
  live.verdict.physicalAndroidDevice = false;
  live.androidDevice.serial = "emulator-5554";
  live.androidDevice.model = "sdk_gphone64_arm64";
  live.androidDevice.isEmulator = true;
});

mutate(process.env.LIVE_NO_HUMAN, (live) => {
  live.verdict.humanTtsOk = false;
  live.verdict.humanAnswerRelevant = false;
  live.verdict.phaseReadyForRelease = false;
});

mutate(process.env.LIVE_AUTH_FAILURE, (live) => {
  live.verdict.authStable = false;
  live.verdict.phaseReadyForRelease = false;
  live.logs.http401 = 1;
});

mutate(process.env.NO_ARM_POLLUTED, (live) => {
  live.verdict.noArmAmbientQueryClean = false;
  live.verdict.noArmAmbientQueryPollution = true;
  live.logs.assistantQueryCaptured = 1;
  live.logs.assistantQuerySubmitting = 1;
  live.logs.assistantQueryAnswered = 1;
});
NODE

expect_success \
  "fresh-live" \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_success \
  "auto-discovery-no-arm-newer" \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$FIXTURE_ANDROID_LIVE_DIR" bash scripts/check-stage-final.sh

expect_success \
  "auto-video-required-with-report" \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" ANDROID_AUTO_VIDEO_JSON="$AUTO_VIDEO_FRESH" REQUIRE_AUTO_VIDEO_LIVE=1 bash scripts/check-stage-final.sh

expect_success \
  "auto-video-auto-discovery-does-not-replace-primary" \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$FIXTURE_ANDROID_LIVE_DIR" REQUIRE_AUTO_VIDEO_LIVE=1 bash scripts/check-stage-final.sh

expect_failure_contains \
  "stale-live" \
  'android_live\.stale' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_STALE" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_failure_contains \
  "missing-live" \
  'android_live_report_missing' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_MISSING" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_failure_contains \
  "missing-live-nextcommands-preserve-logcat" \
  'PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_MISSING" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_failure_contains \
  "emulator-live" \
  'android_live\.physicalAndroidDevice' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_EMULATOR" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_failure_contains \
  "missing-human-confirmation" \
  'android_live\.humanTtsOk' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_NO_HUMAN" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_failure_contains \
  "auth-failure" \
  'android_live\.authStable' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_AUTH_FAILURE" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" bash scripts/check-stage-final.sh

expect_failure_contains \
  "missing-no-arm" \
  'android_no_arm_report_missing' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_MISSING" bash scripts/check-stage-final.sh

expect_failure_contains \
  "stale-no-arm" \
  'android_no_arm\.stale' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_STALE" bash scripts/check-stage-final.sh

expect_failure_contains \
  "polluted-no-arm" \
  'android_no_arm\.noArmAmbientQueryClean' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_POLLUTED" bash scripts/check-stage-final.sh

expect_failure_contains \
  "missing-auto-video-when-required" \
  'android_auto_video_report_missing' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" ANDROID_AUTO_VIDEO_JSON="$TMP_DIR/missing-auto-video.json" REQUIRE_AUTO_VIDEO_LIVE=1 bash scripts/check-stage-final.sh

expect_failure_contains \
  "stale-auto-video-when-required" \
  'android_auto_video\.stale' \
  env STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" PHASE_JSON="$PHASE_READY" ANDROID_LIVE_JSON="$LIVE_FRESH" ANDROID_NO_ARM_JSON="$NO_ARM_FRESH" ANDROID_AUTO_VIDEO_JSON="$AUTO_VIDEO_STALE" REQUIRE_AUTO_VIDEO_LIVE=1 bash scripts/check-stage-final.sh

log "check index includes no-arm report references"
cat >"$FIXTURE_REPORT_DIR/stage-final-index-test.json" <<JSON
{
  "ok": true,
  "generatedAt": 4000,
  "phaseReport": "$PHASE_READY",
  "androidLiveReport": "$LIVE_FRESH",
  "androidNoArmReport": "$NO_ARM_FRESH",
  "androidAutoVideoReport": "$AUTO_VIDEO_FRESH",
  "failures": []
}
JSON
cat >"$FIXTURE_REPORT_DIR/stage-final-no-arm-only-fixture-path.json" <<JSON
{
  "ok": true,
  "generatedAt": 5000,
  "phaseReport": "$ROOT_DIR/.local/current-phase-reports/current-phase-real-looking.json",
  "androidLiveReport": "$ROOT_DIR/.local/android-live-reports/android-live-real-looking.json",
  "androidNoArmReport": "$NO_ARM_FRESH",
  "failures": []
}
JSON
STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" node scripts/index-stage-final-reports.mjs >"$TMP_DIR/index.out"
INDEX_JSON="$FIXTURE_REPORT_DIR/INDEX.json" INDEX_MD="$FIXTURE_REPORT_DIR/INDEX.md" NO_ARM_FRESH="$NO_ARM_FRESH" AUTO_VIDEO_FRESH="$AUTO_VIDEO_FRESH" node <<'NODE'
const fs = require("node:fs");
const index = JSON.parse(fs.readFileSync(process.env.INDEX_JSON, "utf8"));
const markdown = fs.readFileSync(process.env.INDEX_MD, "utf8");
if (!Array.isArray(index.reports)) {
  throw new Error("index.reports missing");
}
if (!index.reports.some((report) => report.androidNoArmReport === process.env.NO_ARM_FRESH)) {
  throw new Error("stage-final index should expose androidNoArmReport references");
}
if (!index.reports.some((report) => report.androidAutoVideoReport === process.env.AUTO_VIDEO_FRESH)) {
  throw new Error("stage-final index should expose androidAutoVideoReport references");
}
if (!markdown.includes("## Android Evidence Reports")) {
  throw new Error("stage-final markdown index should include Android evidence report table");
}
if (!markdown.includes("no-arm-fresh.json")) {
  throw new Error("stage-final markdown index should include no-arm report basename");
}
if (!markdown.includes("auto-video-fresh.json")) {
  throw new Error("stage-final markdown index should include auto-video report basename");
}
const noArmOnlyFixture = index.reports.find((report) => report.name === "stage-final-no-arm-only-fixture-path.json");
if (!noArmOnlyFixture) {
  throw new Error("expected no-arm-only fixture report in index");
}
if (noArmOnlyFixture.kind !== "fixture-smoke") {
  throw new Error(`androidNoArmReport temp path should classify as fixture-smoke, got ${noArmOnlyFixture.kind}`);
}
NODE

log "check doctor ready and missing-primary statuses"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$FIXTURE_ANDROID_LIVE_DIR" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-ready.out"
DOCTOR_OUT="$TMP_DIR/doctor-ready.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== true || report.status !== "ready" || report.finalReady !== true) {
  throw new Error(`expected doctor ready, got ${JSON.stringify({ ok: report.ok, status: report.status, finalReady: report.finalReady })}`);
}
if (report.androidLive?.file == null || report.androidNoArm?.file == null) {
  throw new Error("doctor should expose both Android evidence report paths");
}
NODE

env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$FIXTURE_ANDROID_LIVE_DIR" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" REQUIRE_AUTO_VIDEO_LIVE=1 node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-auto-ready.out"
DOCTOR_OUT="$TMP_DIR/doctor-auto-ready.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== true || report.status !== "ready" || report.finalReady !== true) {
  throw new Error(`expected auto-video doctor ready, got ${JSON.stringify({ ok: report.ok, status: report.status, finalReady: report.finalReady })}`);
}
if (report.androidLive?.file == null || report.androidNoArm?.file == null || report.androidAutoVideo?.file == null) {
  throw new Error("doctor should expose primary/no-arm/auto-video Android evidence report paths");
}
if (report.androidAutoVideo?.ready !== true) {
  throw new Error("doctor auto-video status should be ready when REQUIRE_AUTO_VIDEO_LIVE=1 and report is present");
}
NODE

mkdir -p "$TMP_DIR/doctor-empty-live"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$TMP_DIR/doctor-empty-live" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-missing-primary.out"
DOCTOR_OUT="$TMP_DIR/doctor-missing-primary.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== false || report.status !== "waiting-for-primary-live") {
  throw new Error(`expected waiting-for-primary-live, got ${JSON.stringify({ ok: report.ok, status: report.status })}`);
}
if (!report.nextCommands?.some((command) => command.includes("PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video"))) {
  throw new Error("doctor missing-primary nextCommands should include cumulative capture-video command");
}
if (!report.nextCommands?.some((command) => command.includes("EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect"))) {
  throw new Error("doctor missing-primary nextCommands should include no-arm ambient collect command");
}
NODE

mkdir -p "$TMP_DIR/doctor-missing-primary-strict-auto-video"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$TMP_DIR/doctor-missing-primary-strict-auto-video" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" REQUIRE_AUTO_VIDEO_LIVE=1 node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-missing-primary-strict-auto-video.out"
DOCTOR_OUT="$TMP_DIR/doctor-missing-primary-strict-auto-video.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== false || report.status !== "waiting-for-primary-live") {
  throw new Error(`expected waiting-for-primary-live in strict auto-video mode, got ${JSON.stringify({ ok: report.ok, status: report.status })}`);
}
if (report.requireAutoVideoLive !== true) {
  throw new Error("strict auto-video doctor should expose requireAutoVideoLive=true");
}
if (!report.nextCommands?.some((command) => command.includes("EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect"))) {
  throw new Error("strict auto-video doctor should include auto-video collect command even while primary live is missing");
}
NODE

mkdir -p "$TMP_DIR/doctor-missing-no-arm"
cp "$LIVE_FRESH" "$TMP_DIR/doctor-missing-no-arm/android-live-primary.json"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$TMP_DIR/doctor-missing-no-arm" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-missing-no-arm.out"
DOCTOR_OUT="$TMP_DIR/doctor-missing-no-arm.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== false || report.status !== "waiting-for-no-arm-live") {
  throw new Error(`expected waiting-for-no-arm-live, got ${JSON.stringify({ ok: report.ok, status: report.status })}`);
}
if (!report.androidLive?.ready) {
  throw new Error("doctor missing-no-arm should keep primary live ready");
}
if (!report.nextCommands?.some((command) => command.includes("observe-ambient"))) {
  throw new Error("doctor missing-no-arm nextCommands should start observe-ambient flow");
}
if (!report.nextCommands?.some((command) => command.includes("EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect"))) {
  throw new Error("doctor missing-no-arm nextCommands should include no-arm ambient collect command");
}
NODE

mkdir -p "$TMP_DIR/doctor-missing-auto-video"
cp "$LIVE_FRESH" "$TMP_DIR/doctor-missing-auto-video/android-live-primary.json"
cp "$NO_ARM_FRESH" "$TMP_DIR/doctor-missing-auto-video/android-live-no-arm.json"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$TMP_DIR/doctor-missing-auto-video" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" REQUIRE_AUTO_VIDEO_LIVE=1 node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-missing-auto-video.out"
DOCTOR_OUT="$TMP_DIR/doctor-missing-auto-video.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== false || report.status !== "waiting-for-auto-video-live") {
  throw new Error(`expected waiting-for-auto-video-live, got ${JSON.stringify({ ok: report.ok, status: report.status })}`);
}
if (!report.nextCommands?.some((command) => command.includes("EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect"))) {
  throw new Error("doctor missing-auto-video nextCommands should include auto-video collect command");
}
NODE

mkdir -p "$TMP_DIR/doctor-stale-no-arm"
cp "$LIVE_FRESH" "$TMP_DIR/doctor-stale-no-arm/android-live-primary.json"
cp "$NO_ARM_STALE" "$TMP_DIR/doctor-stale-no-arm/android-live-no-arm-stale.json"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$TMP_DIR/doctor-stale-no-arm" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-stale-no-arm.out"
DOCTOR_OUT="$TMP_DIR/doctor-stale-no-arm.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== false || report.status !== "no-arm-live-stale") {
  throw new Error(`expected no-arm-live-stale, got ${JSON.stringify({ ok: report.ok, status: report.status })}`);
}
if (!report.androidNoArm?.failures?.some((failure) => String(failure).startsWith("android_no_arm.stale"))) {
  throw new Error("doctor stale-no-arm should expose stale failure");
}
NODE

mkdir -p "$TMP_DIR/doctor-polluted-no-arm"
cp "$LIVE_FRESH" "$TMP_DIR/doctor-polluted-no-arm/android-live-primary.json"
cp "$NO_ARM_POLLUTED" "$TMP_DIR/doctor-polluted-no-arm/android-live-no-arm-polluted.json"
env PHASE_JSON="$PHASE_READY" ANDROID_LIVE_REPORT_DIR="$TMP_DIR/doctor-polluted-no-arm" STAGE_FINAL_REPORT_DIR="$FIXTURE_REPORT_DIR" node scripts/check-stage-final-doctor.mjs >"$TMP_DIR/doctor-polluted-no-arm.out"
DOCTOR_OUT="$TMP_DIR/doctor-polluted-no-arm.out" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_OUT, "utf8"));
if (report.ok !== false || report.status !== "no-arm-live-needs-work") {
  throw new Error(`expected no-arm-live-needs-work, got ${JSON.stringify({ ok: report.ok, status: report.status })}`);
}
if (!report.androidNoArm?.failures?.some((failure) => String(failure).includes("noArmAmbientQueryClean"))) {
  throw new Error("doctor polluted-no-arm should expose clean failure");
}
if (!report.androidNoArm?.failures?.some((failure) => String(failure).includes("assistantQueryCaptured"))) {
  throw new Error("doctor polluted-no-arm should expose assistant query pollution logs");
}
NODE

expect_failure_contains \
  "guided-live-requires-tty" \
  'interactive terminal is required' \
  bash scripts/run-final-live-validation.sh </dev/null

log "ok"
