#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function assertContains(raw, needle, label) {
  if (!raw.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`);
  }
}

function assertMatches(raw, pattern, label) {
  if (!pattern.test(raw)) {
    throw new Error(`${label}: missing pattern ${pattern}`);
  }
}

const indexTs = read("index.ts");
const deviceModels = read("android/app/src/main/java/ai/openclaw/clawsense/data/DeviceModels.kt");
const service = read("android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt");
const repository = read("android/app/src/main/java/ai/openclaw/clawsense/data/DeviceSessionRepository.kt");
const liveFixtures = read("scripts/check-android-live-fixtures.sh");
const liveSummary = read("scripts/summarize-android-live-report.mjs");
const checkAndroidLive = read("scripts/check-android-live.sh");

const autoVideoModulePath = path.join(rootDir, "dist/src/auto-video-trigger.js");
if (!fs.existsSync(autoVideoModulePath)) {
  throw new Error("dist/src/auto-video-trigger.js missing; run npm run build first");
}
const { resolveAutoVideoTriggerReason } = await import(pathToFileURL(autoVideoModulePath).href);

const autoVideoTrigger = {
  explicitRecordRequest: resolveAutoVideoTriggerReason("这段很关键，帮我录一下这个") === "explicit_record_request",
  visualReference: resolveAutoVideoTriggerReason("看这里，这页 PPT 上的 chart 是核心") === "visual_reference",
  highInformationMoment: resolveAutoVideoTriggerReason("重点是这个方案的发布节奏") === "high_information_moment",
  ignoresLowSignalText: resolveAutoVideoTriggerReason("嗯嗯好的，今天先这样") === null,
};

for (const [label, ok] of Object.entries(autoVideoTrigger)) {
  if (!ok) {
    throw new Error(`autoVideoTrigger.${label}: failed`);
  }
}

const host = {
  queueStatusCommand: indexTs.includes('.command("queue-status")'),
  analysisRetryCommand: indexTs.includes('.command("analysis-retry")'),
  fastIngestAck: indexTs.includes("stored: true") && indexTs.includes("analysisQueued") && indexTs.includes("analysisQueueDepth"),
  pendingAnalysisRecovery: indexTs.includes("analysis_pending") && indexTs.includes("requeuePendingAnalysis"),
  autoVideoDirectiveIssuer: indexTs.includes("maybeIssueAutoVideoDirective") && indexTs.includes("resolveAutoVideoTriggerReason"),
  directiveBackpressureGuard: indexTs.includes("analysisQueue.length >= Math.floor(MAX_PENDING_ANALYSIS_JOBS * 0.75)"),
  heartbeatDirectiveDelivery:
    indexTs.includes('type: "video_clip"') &&
    indexTs.includes('appState?.startsWith("service")') &&
    indexTs.includes("captureDirective"),
};

for (const [label, ok] of Object.entries(host)) {
  if (!ok) {
    throw new Error(`host.${label}: failed`);
  }
}

const android = {
  autoVideoDefaultOff: deviceModels.includes("val autoVideoEnabled: Boolean = false"),
  autoVideoLimits: deviceModels.includes("autoVideoMaxPerHour: Int = 2") && deviceModels.includes("autoVideoMaxPerDay: Int = 8"),
  heartbeatDirectiveModel: deviceModels.includes("data class CaptureVideoDirective") && deviceModels.includes('val type: String = "video_clip"'),
  disabledGuard: service.includes("auto video disabled"),
  assistantPhaseGuard: service.includes("assistant phase="),
  throttleGuard: service.includes("throttle.pauseAutoVideo") && service.includes("capture throttle level="),
  cooldownAndLimits:
    service.includes("AUTO_VIDEO_COOLDOWN_MS") &&
    service.includes("hourly limit reached") &&
    service.includes("daily limit reached"),
  noteMarkers:
    service.includes('"auto-video-trigger"') &&
    service.includes('"triggerSource=heartbeat-directive"') &&
    service.includes("triggerReason=") &&
    service.includes("sourceEventId=") &&
    service.includes("sourceText="),
  uploadObserved: service.includes("Auto video clip capture requested") && service.includes("Auto video upload succeeded"),
  captureThrottleSnapshot:
    repository.includes("CaptureThrottleSnapshot") &&
    repository.includes("deferLowSignalAudio") &&
    repository.includes("pauseAutoVideo") &&
    repository.includes("skipImmediateStillCapture"),
  debugThrottleInjection:
    repository.includes("injectDebugCaptureThrottle") &&
    checkAndroidLive.includes("inject-throttle") &&
    checkAndroidLive.includes("--ez injectThrottle true"),
};

for (const [label, ok] of Object.entries(android)) {
  if (!ok) {
    throw new Error(`android.${label}: failed`);
  }
}

const liveReport = {
  throttleCounters:
    liveSummary.includes("stillCaptureDeferred") &&
    liveSummary.includes("lowSignalAudioDeferred") &&
    liveSummary.includes("autoVideoThrottled"),
  autoVideoCounters:
    liveSummary.includes("autoVideoCaptureRequested") &&
    liveSummary.includes("autoVideoUploadSucceeded") &&
    liveSummary.includes("autoVideoObserved") &&
    liveSummary.includes("expectsAutoVideo") &&
    liveSummary.includes("autoVideoLiveReady"),
  throttleFixture:
    liveFixtures.includes("REPORT_THROTTLE_JSON") &&
    liveFixtures.includes("Deferring still capture due to throttle") &&
    liveFixtures.includes("Deferring low-signal audio clip due to throttle") &&
    liveFixtures.includes("Skipping auto-video directive"),
  positiveAutoVideoFixture:
    liveFixtures.includes("REPORT_AUTO_VIDEO_JSON") &&
    liveFixtures.includes("EXPECT_AUTO_VIDEO") &&
    liveFixtures.includes("Auto video clip capture requested") &&
    liveFixtures.includes("Auto video upload succeeded"),
  finalGateAutoVideoMode:
    checkAndroidLive.includes("latestAndroidAutoVideo") &&
    read("scripts/check-stage-final.sh").includes("REQUIRE_AUTO_VIDEO_LIVE") &&
    read("scripts/check-stage-final-doctor.mjs").includes("waiting-for-auto-video-live"),
};

for (const [label, ok] of Object.entries(liveReport)) {
  if (!ok) {
    throw new Error(`liveReport.${label}: failed`);
  }
}

const result = {
  ok: true,
  generatedAt: Date.now(),
  phase9: {
    autoVideoTrigger,
    host,
    android,
    liveReport,
  },
};

console.log(JSON.stringify(result, null, 2));
