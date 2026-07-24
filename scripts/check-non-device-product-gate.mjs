#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const localOpenClaw = path.join(projectRoot, "scripts", "local-openclaw.sh");
const resultsDir = path.join(projectRoot, ".local/asr/results");
const defaultReportDir = path.join(projectRoot, ".local/non-device-product-gate-reports");
const publicZhClipPath = path.join(
  projectRoot,
  ".local/asr/external/alimeeting/R8002_M8002_MS802.far-mono.120s.wav",
);
const requirePublicZhReplay = process.env.CLAWSENSE_REQUIRE_PUBLIC_ZH_REPLAY === "1";
const mode = process.argv[2] ?? "run";
const defaultStaleAfterHours = 24;

const checks = [];

function parseJsonObject(stdout, label) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw Object.assign(new Error(`${label} did not output a JSON object`), {
      details: text.slice(0, 3000),
    });
  }
  return JSON.parse(text.slice(start, end + 1));
}

function runCommand(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180_000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const durationMs = Date.now() - startedAt;
  if (result.error) {
    throw Object.assign(new Error(`${options.label ?? command} failed to start: ${result.error.message}`), {
      details: { command, args, durationMs },
    });
  }
  if (result.status !== 0) {
    throw Object.assign(new Error(`${options.label ?? command} exited with ${result.status}`), {
      details: {
        command,
        args,
        status: result.status,
        durationMs,
        stdout: String(result.stdout ?? "").slice(-6000),
        stderr: String(result.stderr ?? "").slice(-6000),
      },
    });
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
  };
}

function runNodeScript(scriptPath, options = {}) {
  const label = options.label ?? scriptPath;
  const result = runCommand(process.execPath, [scriptPath], {
    label,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  return {
    durationMs: result.durationMs,
    payload: parseJsonObject(result.stdout, label),
  };
}

function runOpenClaw(args, label, timeoutMs = 120_000) {
  const result = runCommand(localOpenClaw, ["openclaw", ...args], {
    label,
    timeoutMs,
  });
  return {
    durationMs: result.durationMs,
    payload: parseJsonObject(result.stdout, label),
  };
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw Object.assign(new Error(message), { details });
  }
}

function safeTimestamp(iso) {
  return iso.replace(/[:.]/g, "-");
}

function resolveReportDir() {
  const configured = process.env.CLAWSENSE_NON_DEVICE_GATE_REPORT_DIR;
  if (!configured) return defaultReportDir;
  return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
}

function writeGateReport(result) {
  fs.mkdirSync(result.report.reportDir, { recursive: true });
  fs.writeFileSync(result.report.path, `${JSON.stringify(result, null, 2)}\n`);
  fs.copyFileSync(result.report.path, result.report.latestPath);
}

function readPositiveNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function summarizeReportFreshness(checkedAt) {
  const staleAfterHours = readPositiveNumber(process.env.CLAWSENSE_NON_DEVICE_GATE_STALE_AFTER_HOURS, defaultStaleAfterHours);
  const checkedMs = Date.parse(String(checkedAt ?? ""));
  if (!Number.isFinite(checkedMs)) {
    return {
      checkedAtValid: false,
      ageMs: null,
      ageHours: null,
      staleAfterHours,
      isStale: true,
      warning: "latest report checkedAt is missing or invalid; rerun npm run check:non-device-product-gate",
    };
  }
  const ageMs = Math.max(0, Date.now() - checkedMs);
  const ageHours = ageMs / 3_600_000;
  const isStale = ageHours > staleAfterHours;
  return {
    checkedAtValid: true,
    ageMs,
    ageHours: Number(ageHours.toFixed(2)),
    staleAfterHours,
    isStale,
    ...(isStale
      ? { warning: `latest report is older than ${staleAfterHours}h; rerun npm run check:non-device-product-gate before sign-off` }
      : {}),
  };
}

function findCheck(report, id) {
  return (Array.isArray(report.checks) ? report.checks : []).find((check) => check.id === id);
}

function readLatestGateReport() {
  const reportDir = resolveReportDir();
  const latestPath = path.join(reportDir, "latest.json");
  assert(fs.existsSync(latestPath), "latest non-device product gate report was not found", {
    latestPath,
    nextCommand: "npm run check:non-device-product-gate",
  });
  return JSON.parse(fs.readFileSync(latestPath, "utf8"));
}

function summarizeLatestGateReport(report) {
  const evidenceV2 = findCheck(report, "evidence-v2-synthetic")?.summary ?? {};
  const conversationRouting = findCheck(report, "conversation-routing")?.summary ?? {};
  const historical = findCheck(report, "historical-real-state")?.summary ?? {};
  const activeRawAudio = findCheck(report, "active-raw-audio-positive")?.summary ?? {};
  const speakerSlots = findCheck(report, "speaker-slots-positive")?.summary ?? {};
  const autoVideo = findCheck(report, "auto-video-trigger-fixture")?.summary ?? {};
  return {
    ok: report.ok === true,
    checkedAt: report.checkedAt,
    freshness: summarizeReportFreshness(report.checkedAt),
    report: report.report,
    summary: report.summary,
    highlights: {
      evidenceV2RawAudioArtifacts: evidenceV2.rawAudioArtifacts,
      evidenceV2AudioBlockerIds: evidenceV2.audioBlockerIds ?? [],
      publicAmiRawAudioArtifacts: conversationRouting.publicAmiRawAudioArtifacts,
      publicAmiAudioEvents: conversationRouting.publicAmiAudioEvents,
      publicAmiTranscriptReadyEvents: conversationRouting.publicAmiTranscriptReadyEvents,
      publicAmiSpeakerTimelineReadyEvents: conversationRouting.publicAmiSpeakerTimelineReadyEvents,
      publicAmiAudioBlockerIds: conversationRouting.publicAmiAudioBlockerIds ?? [],
      historicalRawAudioArtifacts: historical.rawAudioArtifacts,
      historicalContextAudioMatchesDiagnostics: historical.contextAudioMatchesDiagnostics,
      historicalAudioBlockerIds: historical.audioBlockerIds ?? [],
      activeRawAudioArtifacts: activeRawAudio.rawAudioArtifacts,
      speakerSlotCount: speakerSlots.slotCount,
      mappedSpeakerSlotCount: speakerSlots.mappedSlotCount,
      autoVideoDirectiveBackpressureGuard: autoVideo.directiveBackpressureGuard,
    },
    checks: (Array.isArray(report.checks) ? report.checks : []).map((check) => ({
      id: check.id,
      status: check.status,
      durationMs: check.durationMs,
    })),
  };
}

async function addCheck(id, title, fn) {
  const startedAt = Date.now();
  console.error(`[non-device-gate] ${id}: ${title}`);
  try {
    const result = await fn();
    checks.push({
      id,
      title,
      status: result?.status ?? "passed",
      durationMs: Date.now() - startedAt,
      ...(result ?? {}),
    });
  } catch (error) {
    checks.push({
      id,
      title,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error.message,
      details: error.details,
    });
  }
}

function hasPublicZhReplayInputs() {
  if (!fs.existsSync(publicZhClipPath)) return false;
  if (!fs.existsSync(resultsDir)) return false;
  return fs
    .readdirSync(resultsDir)
    .some((name) => /^public-zh-alimeeting-(?:funasr|whisper)-primary-.*\.json$/.test(name));
}

function summarizeEvidenceV2(payload) {
  return {
    ok: payload.ok === true,
    transcriptSpanCount: payload.evidence?.transcriptSpanCount ?? payload.context?.transcriptSpanCount,
    topicSegmentCount: payload.evidence?.topicSegmentCount ?? payload.context?.topicSegmentCount,
    taskAttributionStatus: payload.evidence?.taskAttributionStatus ?? payload.context?.taskAttributionStatus,
    evidenceFollowUpTargetCount: payload.followups?.evidenceFollowUpTargetCount,
    rawAudioArtifacts: payload.rawAudioArtifacts,
    audioEvents: payload.audioEvents,
    transcriptReadyEvents: payload.transcriptReadyEvents,
    speakerTimelineReadyEvents: payload.speakerTimelineReadyEvents,
    audioBlockerIds: payload.audioBlockerIds ?? [],
  };
}

function summarizeEvidenceLocal(payload) {
  const contextRawAudioArtifacts = payload.context?.contextAudioRawAudioArtifacts;
  const contextAudioBlockerIds = payload.context?.contextAudioBlockerIds ?? [];
  return {
    ok: payload.ok === true,
    date: payload.date,
    transcriptSpanCount: payload.context?.transcriptSpanCount,
    rollingDigestMatchCount: payload.context?.rollingDigestMatchCount,
    memoryCardCount: payload.context?.memoryCardCount,
    memoryCardMatchCount: payload.context?.memoryCardMatchCount,
    conversationDigestTaskMatchCount: payload.context?.conversationDigestTaskMatchCount,
    taskAttributionStatus: payload.context?.taskAttributionStatus,
    contextRawAudioArtifacts,
    contextAudioBlockerIds,
    contextAudioMatchesDiagnostics:
      contextRawAudioArtifacts === payload.audioDiagnostics?.verdict?.rawAudioArtifacts,
    rawAudioArtifacts: payload.audioDiagnostics?.verdict?.rawAudioArtifacts,
    audioBlockerIds: payload.audioDiagnostics?.blockerIds ?? [],
    audioNextActionCount: payload.audioDiagnostics?.nextActionCount ?? 0,
    audioEvents: payload.audioDiagnostics?.counts?.audioEvents,
    audioArtifactRecords: payload.audioDiagnostics?.counts?.audioArtifactRecords,
    activeAudioArtifactRecords: payload.audioDiagnostics?.counts?.activeAudioArtifactRecords,
  };
}

function summarizeReplay(payload) {
  return {
    ok: payload.ok === true,
    fixtureDate: payload.replay?.fixtureDate,
    segmentCount: payload.replay?.segmentCount,
    transcriptSpanCount: payload.before?.transcriptSpanCount,
    topicSegmentCount: payload.before?.topicSegmentCount,
    evidenceFollowUpTargetCount: payload.before?.evidenceFollowUpTargetCount,
    annotatedSpeaker: payload.annotation?.displayName,
    postAnnotationSpeakerSlots: payload.after?.speakerSlots?.length,
  };
}

function summarizeAudioDiagnostics(payload) {
  return {
    ok: payload.ok !== false,
    date: payload.date,
    audioEvents: payload.counts?.audioEvents,
    transcriptReadyEvents: payload.counts?.transcriptReadyEvents,
    speakerTimelineReadyEvents: payload.counts?.speakerTimelineReadyEvents,
    audioArtifactRecords: payload.counts?.audioArtifactRecords,
    activeAudioArtifactRecords: payload.counts?.activeAudioArtifactRecords,
    deletedAudioArtifactRecords: payload.counts?.deletedAudioArtifactRecords,
    rawAudioArtifacts: payload.verdict?.rawAudioArtifacts,
  };
}

function summarizeSpeakerSlots(payload) {
  const suggestedSlots = Array.isArray(payload.suggestedSlots) ? payload.suggestedSlots : [];
  const knownSpeakers = Array.isArray(payload.knownSpeakers) ? payload.knownSpeakers : [];
  const slotTaskImpacts = Array.isArray(payload.slotTaskImpacts) ? payload.slotTaskImpacts : [];
  return {
    ok: payload.ok !== false,
    date: payload.date,
    status: payload.status,
    slotCount: payload.summary?.slotCount ?? payload.summary?.suggestedSlotCount ?? suggestedSlots.length,
    unresolvedSlotCount: payload.summary?.unresolvedSlotCount,
    mappedSlotCount:
      payload.summary?.mappedSlotCount ??
      suggestedSlots.filter((slot) => typeof slot.displayName === "string" && slot.displayName.trim()).length,
    hasAnnotatedSarah:
      suggestedSlots.some((slot) => slot.displayName === "Sarah") ||
      knownSpeakers.some((speaker) => speaker.displayName === "Sarah"),
    quickCommandCount: payload.quickCommands?.length ?? 0,
    impactedSlotCount: payload.summary?.impactedSlotCount ?? slotTaskImpacts.length,
    slotTaskImpactCount: slotTaskImpacts.length,
    hasSlotTaskImpactCommands: slotTaskImpacts.some(
      (impact) => typeof impact?.commands?.markAsMe === "string" && typeof impact?.commands?.markAsColleague === "string",
    ),
    hasDiarizationSignal: slotTaskImpacts.some((impact) => typeof impact?.requiresDiarization === "boolean"),
  };
}

if (mode === "--help" || mode === "help" || mode === "-h") {
  console.log(`Usage:
  node scripts/check-non-device-product-gate.mjs
  node scripts/check-non-device-product-gate.mjs --latest

Modes:
  run       Run the full non-device product gate and write a timestamped report.
  --latest  Read .local/non-device-product-gate-reports/latest.json and print a compact summary.

Environment:
  CLAWSENSE_NON_DEVICE_GATE_REPORT_DIR  Override report directory.
  CLAWSENSE_REQUIRE_PUBLIC_ZH_REPLAY=1  Require optional Chinese public meeting replay.`);
  process.exit(0);
}

if (mode === "--latest" || mode === "latest") {
  try {
    const report = readLatestGateReport();
    console.log(JSON.stringify(summarizeLatestGateReport(report), null, 2));
    process.exit(report.ok === true ? 0 : 1);
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          mode: "latest",
          error: error.message,
          details: error.details,
          nextCommand: "npm run check:non-device-product-gate",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

if (mode !== "run") {
  console.error(`Unknown mode: ${mode}`);
  console.error("Run with --help for usage.");
  process.exit(2);
}

await addCheck("evidence-v2-synthetic", "音频+图片证据包、任务归因、统一追问 synthetic smoke", () => {
  const { payload } = runNodeScript("scripts/check-evidence-v2-smoke.mjs", {
    label: "check-evidence-v2-smoke",
  });
  assert(payload.ok === true, "evidence v2 smoke did not pass", payload);
  return { summary: summarizeEvidenceV2(payload) };
});

await addCheck("conversation-routing", "长历史问题路由与跨窗口 conversation digest smoke", () => {
  const { payload } = runNodeScript("scripts/check-conversation-evidence-routing-smoke.mjs", {
    label: "check-conversation-evidence-routing-smoke",
  });
  assert(payload.ok === true, "conversation routing smoke did not pass", payload);
  return {
    summary: {
      ok: true,
      rangeBuildScope: payload.rangeBuildCall?.scope,
      yesterdayBuildScope: payload.yesterdayBuildCall?.scope,
      publicAmiTranscriptSpanCount: payload.publicAmi?.transcriptSpanCount,
      publicAmiRawAudioArtifacts: payload.publicAmi?.rawAudioArtifacts,
      publicAmiAudioEvents: payload.publicAmi?.audioEvents,
      publicAmiTranscriptReadyEvents: payload.publicAmi?.transcriptReadyEvents,
      publicAmiSpeakerTimelineReadyEvents: payload.publicAmi?.speakerTimelineReadyEvents,
      publicAmiAudioBlockerIds: payload.publicAmi?.audioBlockerIds ?? [],
      publicAmiSpeakerSlotCount: payload.publicAmi?.speakerSlots?.length,
    },
  };
});

await addCheck("historical-real-state", "6 月 25 日真实历史素材 evidence/local diagnostics", () => {
  const { payload } = runNodeScript("scripts/check-local-openclaw-evidence-smoke.mjs", {
    label: "check-local-openclaw-evidence-smoke",
    timeoutMs: 180_000,
  });
  assert(payload.ok === true, "local evidence smoke did not pass", payload);
  assert(
    payload.context?.contextAudioRawAudioArtifacts === payload.audioDiagnostics?.verdict?.rawAudioArtifacts,
    "context evidence should expose the same raw audio verdict as audio-diagnostics",
    {
      context: {
        contextAudioRawAudioArtifacts: payload.context?.contextAudioRawAudioArtifacts,
        contextAudioBlockerIds: payload.context?.contextAudioBlockerIds,
      },
      audioDiagnostics: payload.audioDiagnostics?.verdict,
    },
  );
  assert(
    payload.audioDiagnostics?.verdict?.rawAudioArtifacts === "available" ||
      payload.audioDiagnostics?.verdict?.rawAudioArtifacts === "deleted",
    "historical audio diagnostics should distinguish available vs retention-deleted raw artifacts",
    payload.audioDiagnostics,
  );
  if (payload.audioDiagnostics?.verdict?.rawAudioArtifacts === "deleted") {
    assert(
      payload.audioDiagnostics?.blockerIds?.includes("raw-audio-retention-deleted"),
      "retention-deleted historical audio should surface a raw-audio-retention-deleted blocker",
      payload.audioDiagnostics,
    );
    assert(
      payload.context?.contextAudioBlockerIds?.includes("raw-audio-retention-deleted"),
      "retention-deleted historical audio should also be visible in context evidence",
      payload.context,
    );
    assert(
      (payload.audioDiagnostics?.nextActionCount ?? 0) > 0,
      "retention-deleted historical audio should surface human-readable next actions",
      payload.audioDiagnostics,
    );
  }
  return { summary: summarizeEvidenceLocal(payload) };
});

await addCheck("public-ami-asr-cache", "公开 AMI WAV + cached local ASR/diarization positive sample", () => {
  const { payload } = runNodeScript("scripts/check-public-wav-asr-smoke.mjs", {
    label: "check-public-wav-asr-smoke",
    timeoutMs: 600_000,
  });
  assert(payload.ok === true, "public AMI wav ASR smoke did not pass", payload);
  return {
    summary: {
      ok: true,
      mode: payload.mode,
      durationSec: payload.clipWav?.durationSec,
      transcriptLength: payload.result?.transcriptLength,
      segmentCount: payload.result?.segmentCount,
      speakerTimelineSegmentCount: payload.result?.speakerTimelineSegmentCount,
      speakerLabels: payload.result?.speakerLabels,
    },
  };
});

await addCheck("public-ami-replay", "公开 AMI replay 到 OpenClaw state + speaker 标注闭环", () => {
  const { payload } = runNodeScript("scripts/check-public-ami-replay-cli-smoke.mjs", {
    label: "check-public-ami-replay-cli-smoke",
    timeoutMs: 240_000,
  });
  assert(payload.ok === true, "public AMI replay did not pass", payload);
  return { summary: summarizeReplay(payload) };
});

await addCheck("active-raw-audio-positive", "replay 后 active raw audio artifact 与 speaker timeline 正向诊断", () => {
  const { payload } = runOpenClaw(["clawsense", "audio-diagnostics", "2026-01-15"], "audio-diagnostics-2026-01-15");
  const summary = summarizeAudioDiagnostics(payload);
  assert(summary.audioEvents > 0, "public AMI replay should create audio events", summary);
  assert(summary.transcriptReadyEvents > 0, "public AMI replay should expose transcript-ready audio", summary);
  assert(summary.speakerTimelineReadyEvents > 0, "public AMI replay should expose speaker timeline", summary);
  assert(summary.activeAudioArtifactRecords > 0, "public AMI replay should keep active raw audio artifacts", summary);
  assert(summary.rawAudioArtifacts === "available", "public AMI replay raw artifacts should be available", summary);
  return { summary };
});

await addCheck("speaker-slots-positive", "speaker-slots 可观测性与已标注 speaker 复用", () => {
  const { payload } = runOpenClaw(
    [
      "clawsense",
      "speaker-slots",
      "2026-01-15",
      "--question",
      "2026-01-15 公开 AMI 会议里，Sarah 说了什么？",
    ],
    "speaker-slots-2026-01-15",
  );
  const summary = summarizeSpeakerSlots(payload);
  assert(summary.slotCount > 0, "speaker-slots should expose at least one slot", summary);
  assert(summary.status === "ready" || summary.status === "needs-speaker-labels", "speaker-slots status should be actionable", summary);
  assert(summary.hasAnnotatedSarah, "speaker-slots should reuse the Sarah annotation from public AMI replay", summary);
  assert(summary.slotTaskImpactCount > 0, "speaker-slots should expose task/person impact hints", summary);
  assert(summary.hasSlotTaskImpactCommands, "speaker-slots impact hints should include copyable annotation commands", summary);
  assert(summary.hasDiarizationSignal, "speaker-slots impact hints should expose whether diarization is still needed", summary);
  return { summary };
});

await addCheck("auto-video-trigger-fixture", "端侧主动录视频触发规则与拥塞保护 fixture", () => {
  const { payload } = runNodeScript("scripts/check-phase9-fixtures.mjs", {
    label: "check-phase9-fixtures",
  });
  assert(payload.ok === true, "phase9 auto-video fixture did not pass", payload);
  return {
    summary: {
      ok: true,
      explicitRecordRequest: payload.phase9?.autoVideoTrigger?.explicitRecordRequest,
      visualReference: payload.phase9?.autoVideoTrigger?.visualReference,
      highInformationMoment: payload.phase9?.autoVideoTrigger?.highInformationMoment,
      ignoresLowSignalText: payload.phase9?.autoVideoTrigger?.ignoresLowSignalText,
      directiveBackpressureGuard: payload.phase9?.host?.directiveBackpressureGuard,
    },
  };
});

await addCheck("public-zh-replay-optional", "中文公开会议 replay 可选正向样例", () => {
  if (!hasPublicZhReplayInputs()) {
    if (requirePublicZhReplay) {
      throw Object.assign(new Error("Chinese public replay inputs are missing"), {
        details: {
          clipPath: publicZhClipPath,
          nextCommands: [
            "CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting",
            "CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting",
            "npm run check:public-zh-replay",
          ],
        },
      });
    }
    return {
      status: "skipped",
      summary: {
        reason: "missing cached AliMeeting clip or ASR result",
        clipPath: publicZhClipPath,
        nextCommands: [
          "CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting",
          "CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting",
          "npm run check:public-zh-replay",
        ],
      },
    };
  }
  const { payload } = runNodeScript("scripts/check-public-zh-meeting-replay-cli-smoke.mjs", {
    label: "check-public-zh-meeting-replay-cli-smoke",
    timeoutMs: 240_000,
  });
  assert(payload.ok === true, "public Chinese meeting replay did not pass", payload);
  return { summary: summarizeReplay(payload) };
});

const summary = {
  passed: checks.filter((check) => check.status === "passed").length,
  skipped: checks.filter((check) => check.status === "skipped").length,
  failed: checks.filter((check) => check.status === "failed").length,
  realDeviceRequired: false,
};

const checkedAt = new Date().toISOString();
const reportDir = resolveReportDir();
const reportPath = path.join(reportDir, `non-device-product-gate-${safeTimestamp(checkedAt)}.json`);
const latestPath = path.join(reportDir, "latest.json");

const result = {
  ok: summary.failed === 0,
  checkedAt,
  purpose:
    "Non-device ClawSense product gate: validates evidence routing, historical recall, ASR/diarization replay, speaker annotation, and auto-video fixtures without a real Android device.",
  report: {
    reportDir,
    path: reportPath,
    latestPath,
  },
  summary,
  checks,
};

writeGateReport(result);
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}
