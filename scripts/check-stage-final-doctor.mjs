#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const currentPhaseDir = process.env.CURRENT_PHASE_REPORT_DIR
  ? path.resolve(process.env.CURRENT_PHASE_REPORT_DIR)
  : path.join(rootDir, ".local", "current-phase-reports");
const androidLiveDir = process.env.ANDROID_LIVE_REPORT_DIR
  ? path.resolve(process.env.ANDROID_LIVE_REPORT_DIR)
  : path.join(rootDir, ".local", "android-live-reports");
const stageFinalDir = process.env.STAGE_FINAL_REPORT_DIR
  ? path.resolve(process.env.STAGE_FINAL_REPORT_DIR)
  : path.join(rootDir, ".local", "stage-final-reports");
const emulatorSmokeDir = process.env.EMULATOR_SMOKE_REPORT_DIR
  ? path.resolve(process.env.EMULATOR_SMOKE_REPORT_DIR)
  : path.join(rootDir, ".local", "android-emulator-smoke-reports");

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { parseError: String(error?.message || error) };
  }
}

function latestFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const files = fs
    .readdirSync(dir)
    .filter((name) => regex.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, stat: fs.statSync(file) };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file));
  return files[0]?.file || null;
}

function latestAndroidReport(mode) {
  if (!fs.existsSync(androidLiveDir)) return null;
  const records = [];
  for (const name of fs.readdirSync(androidLiveDir)) {
    if (!/^android-live-.*\.json$/.test(name)) continue;
    const file = path.join(androidLiveDir, name);
    const report = readJson(file);
    if (!report || report.parseError) continue;
    const noArm = report?.verdict?.expectsNoAssistantQuery === true;
    const autoVideo = report?.verdict?.expectsAutoVideo === true;
    if (
      (mode === "no-arm" && noArm) ||
      (mode === "auto-video" && autoVideo) ||
      (mode === "primary" && !noArm && !autoVideo)
    ) {
      records.push({ file, generatedAt: Number(report.generatedAt || 0) });
    }
  }
  records.sort((a, b) => b.generatedAt - a.generatedAt || b.file.localeCompare(a.file));
  return records[0]?.file || null;
}

function isFixturePath(value) {
  const text = String(value || "");
  return text.includes("/var/folders/") || text.includes("/tmp/") || text.includes("\\Temp\\") || text.includes("\\tmp\\");
}

function latestRealStageFinal() {
  if (!fs.existsSync(stageFinalDir)) return null;
  const reports = [];
  for (const name of fs.readdirSync(stageFinalDir)) {
    if (!/^stage-final-.*\.json$/.test(name)) continue;
    const file = path.join(stageFinalDir, name);
    const report = readJson(file);
    if (!report || report.parseError) continue;
    const fixtureLike =
      isFixturePath(report.phaseReport) ||
      isFixturePath(report.androidLiveReport) ||
      isFixturePath(report.androidNoArmReport) ||
      isFixturePath(report.path);
    if (fixtureLike) continue;
    reports.push({
      file,
      generatedAt: Number(report.generatedAt || 0),
      ok: report.ok === true,
      failure: report.failure || (Array.isArray(report.failures) && report.failures.length > 0 ? report.failures.join("; ") : null),
    });
  }
  reports.sort((a, b) => b.generatedAt - a.generatedAt || b.file.localeCompare(a.file));
  return reports[0] || null;
}

function phaseStatus(file) {
  const report = readJson(file);
  if (!report) {
    return { ready: false, missing: true, file: null, generatedAt: null, failures: ["current_phase_report_missing"] };
  }
  const failures = [];
  if (report.ok !== true) failures.push("current_phase.ok");
  if (report.acceptance?.phaseState !== "ready-to-close") {
    failures.push(`current_phase.acceptance.phaseState:${report.acceptance?.phaseState ?? "<missing>"}`);
  }
  if (report.acceptance?.passedCriteria !== report.acceptance?.totalCriteria) {
    failures.push(`current_phase.acceptance.criteria:${report.acceptance?.passedCriteria ?? "<missing>"}/${report.acceptance?.totalCriteria ?? "<missing>"}`);
  }
  if (Number(report.videoEvidence?.transcriptSpans || 0) < 1) failures.push("current_phase.video.transcriptSpans");
  if (Number(report.videoEvidence?.keyframeDetails || 0) < 1) failures.push("current_phase.video.keyframeDetails");
  return {
    ready: failures.length === 0,
    file,
    generatedAt: Number(report.generatedAt || 0) || null,
    acceptance: report.acceptance || null,
    videoEvidence: report.videoEvidence || null,
    failures,
  };
}

function primaryLiveStatus(file, phaseGeneratedAt) {
  const report = readJson(file);
  if (!report) {
    return { ready: false, missing: true, file: null, generatedAt: null, failures: ["android_live_report_missing"] };
  }
  const failures = [];
  const verdict = report.verdict || {};
  const host = report.host || {};
  const generatedAt = Number(report.generatedAt || 0) || null;
  if (generatedAt && phaseGeneratedAt && generatedAt < phaseGeneratedAt) {
    failures.push(`android_live.stale:liveGeneratedAt=${generatedAt}:phaseGeneratedAt=${phaseGeneratedAt}`);
  }
  if (report.ok !== true) failures.push("android_live.ok");
  if (verdict.physicalAndroidDevice !== true) failures.push("android_live.physicalAndroidDevice");
  if (verdict.hostDeviceSeen !== true) failures.push("android_live.hostDeviceSeen");
  if (verdict.voiceLoopObserved !== true) failures.push("android_live.voiceLoopObserved");
  if (verdict.ttsStatus !== "pass") failures.push(`android_live.ttsStatus:${verdict.ttsStatus ?? "<missing>"}`);
  if (verdict.humanTtsOk !== true) failures.push("android_live.humanTtsOk");
  if (verdict.humanAnswerRelevant !== true) failures.push("android_live.humanAnswerRelevant");
  if (verdict.stopTtsObserved !== true) failures.push("android_live.stopTtsObserved");
  if (verdict.videoStatus !== "upload-observed") failures.push(`android_live.videoStatus:${verdict.videoStatus ?? "<missing>"}`);
  if (verdict.authStable !== true) failures.push("android_live.authStable");
  if (verdict.phaseReadyForRelease !== true) failures.push("android_live.phaseReadyForRelease");
  if (Number(host.videoEvidenceGroups || 0) < 1) failures.push("android_live.host.videoEvidenceGroups");
  if (Number(host.videoTranscriptSpans || 0) < 1) failures.push("android_live.host.videoTranscriptSpans");
  if (Number(host.videoKeyframeDetails || 0) < 1) failures.push("android_live.host.videoKeyframeDetails");
  return {
    ready: failures.length === 0,
    file,
    generatedAt,
    verdict,
    androidDevice: report.androidDevice || null,
    androidPackage: report.androidPackage || null,
    host,
    failures,
  };
}

function noArmStatus(file, phaseGeneratedAt) {
  const report = readJson(file);
  if (!report) {
    return { ready: false, missing: true, file: null, generatedAt: null, failures: ["android_no_arm_report_missing"] };
  }
  const failures = [];
  const verdict = report.verdict || {};
  const logs = report.logs || {};
  const generatedAt = Number(report.generatedAt || 0) || null;
  if (generatedAt && phaseGeneratedAt && generatedAt < phaseGeneratedAt) {
    failures.push(`android_no_arm.stale:noArmGeneratedAt=${generatedAt}:phaseGeneratedAt=${phaseGeneratedAt}`);
  }
  if (report.ok !== true) failures.push("android_no_arm.ok");
  if (verdict.expectsNoAssistantQuery !== true) failures.push("android_no_arm.expectsNoAssistantQuery");
  if (verdict.noArmAmbientQueryClean !== true) failures.push("android_no_arm.noArmAmbientQueryClean");
  if (verdict.noArmAmbientQueryPollution !== false) {
    failures.push(`android_no_arm.noArmAmbientQueryPollution:${verdict.noArmAmbientQueryPollution ?? "<missing>"}`);
  }
  for (const key of ["assistantQueryArmed", "assistantQueryCaptured", "assistantQuerySubmitting", "assistantQueryAnswered"]) {
    if (Number(logs[key] || 0) > 0) failures.push(`android_no_arm.logs.${key}:${logs[key]}`);
  }
  return {
    ready: failures.length === 0,
    file,
    generatedAt,
    verdict,
    logs,
    failures,
  };
}

function autoVideoStatus(file, phaseGeneratedAt) {
  const report = readJson(file);
  if (!report) {
    return { ready: false, missing: true, file: null, generatedAt: null, failures: ["android_auto_video_report_missing"] };
  }
  const failures = [];
  const verdict = report.verdict || {};
  const logs = report.logs || {};
  const host = report.host || {};
  const generatedAt = Number(report.generatedAt || 0) || null;
  if (generatedAt && phaseGeneratedAt && generatedAt < phaseGeneratedAt) {
    failures.push(`android_auto_video.stale:autoVideoGeneratedAt=${generatedAt}:phaseGeneratedAt=${phaseGeneratedAt}`);
  }
  if (report.ok !== true) failures.push("android_auto_video.ok");
  if (verdict.physicalAndroidDevice !== true) failures.push("android_auto_video.physicalAndroidDevice");
  if (verdict.expectsAutoVideo !== true) failures.push("android_auto_video.expectsAutoVideo");
  if (verdict.autoVideoObserved !== true) failures.push("android_auto_video.autoVideoObserved");
  if (verdict.autoVideoLiveReady !== true) failures.push("android_auto_video.autoVideoLiveReady");
  if (verdict.authStable !== true) failures.push("android_auto_video.authStable");
  if (verdict.videoStatus !== "upload-observed") {
    failures.push(`android_auto_video.videoStatus:${verdict.videoStatus ?? "<missing>"}`);
  }
  if (Number(logs.autoVideoUploadSucceeded || 0) < 1) {
    failures.push(`android_auto_video.logs.autoVideoUploadSucceeded:${logs.autoVideoUploadSucceeded ?? 0}`);
  }
  if (Number(host.videoEvidenceGroups || 0) < 1) failures.push("android_auto_video.host.videoEvidenceGroups");
  if (Number(host.videoKeyframeDetails || 0) < 1) failures.push("android_auto_video.host.videoKeyframeDetails");
  return {
    ready: failures.length === 0,
    file,
    generatedAt,
    verdict,
    logs,
    host,
    failures,
  };
}

function inferStatus(phase, primary, noArm, autoVideo, requireAutoVideoLive) {
  if (phase.ready && primary.ready && noArm.ready && (!requireAutoVideoLive || autoVideo.ready)) return "ready";
  if (!phase.ready) return "phase-not-ready";
  if (primary.missing || primary.failures.includes("android_live_report_missing")) return "waiting-for-primary-live";
  if (primary.failures.some((item) => item.startsWith("android_live.stale"))) return "primary-live-stale";
  if (!primary.ready) return "primary-live-needs-work";
  if (noArm.missing || noArm.failures.includes("android_no_arm_report_missing")) return "waiting-for-no-arm-live";
  if (noArm.failures.some((item) => item.startsWith("android_no_arm.stale"))) return "no-arm-live-stale";
  if (requireAutoVideoLive && (autoVideo.missing || autoVideo.failures.includes("android_auto_video_report_missing"))) {
    return "waiting-for-auto-video-live";
  }
  if (requireAutoVideoLive && autoVideo.failures.some((item) => item.startsWith("android_auto_video.stale"))) {
    return "auto-video-live-stale";
  }
  if (requireAutoVideoLive && !autoVideo.ready) return "auto-video-live-needs-work";
  return "no-arm-live-needs-work";
}

function autoVideoNextCommands() {
  return [
    "# enable auto-video evidence enhancement on the Android UI",
    "# play/say a trigger phrase such as: 看这里，这页 PPT 是重点，帮我看一下这段演示。",
    "EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect",
    "REQUIRE_AUTO_VIDEO_LIVE=1 npm run check:stage-final",
  ];
}

function withAutoVideoCommands(commands, requireAutoVideoLive, autoVideo) {
  if (!requireAutoVideoLive || autoVideo.ready) return commands;
  return [...commands, ...autoVideoNextCommands()];
}

function nextCommands(status, requireAutoVideoLive, autoVideo) {
  if (status === "ready") {
    return ["npm run check:stage-final"];
  }
  if (status === "phase-not-ready") {
    return withAutoVideoCommands(["npm run check:phase"], requireAutoVideoLive, autoVideo);
  }
  if (status === "waiting-for-primary-live" || status === "primary-live-stale" || status === "primary-live-needs-work") {
    return withAutoVideoCommands([
      "npm run check:android-live:doctor",
      "npm run check:android-live",
      "scripts/check-android-live.sh arm-query auto",
      "PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting",
      "PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts",
      "PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video",
      "HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect",
      "scripts/check-android-live.sh observe-ambient",
      "EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect",
    ], requireAutoVideoLive, autoVideo);
  }
  if (status === "waiting-for-auto-video-live" || status === "auto-video-live-stale" || status === "auto-video-live-needs-work") {
    return [
      "npm run check:android-live:doctor",
      "npm run check:android-live",
      ...autoVideoNextCommands(),
    ];
  }
  return withAutoVideoCommands([
    "scripts/check-android-live.sh observe-ambient",
    "EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect",
  ], requireAutoVideoLive, autoVideo);
}

const phaseFile = process.env.PHASE_JSON ? path.resolve(process.env.PHASE_JSON) : latestFile(currentPhaseDir, /^current-phase-.*\.json$/);
const phase = phaseStatus(phaseFile);
const primaryFile = latestAndroidReport("primary");
const primary = primaryLiveStatus(primaryFile, phase.generatedAt);
const noArmFile = latestAndroidReport("no-arm");
const noArm = noArmStatus(noArmFile, phase.generatedAt);
const autoVideoFile = latestAndroidReport("auto-video");
const autoVideo = autoVideoStatus(autoVideoFile, phase.generatedAt);
const latestStageFinal = latestRealStageFinal();
const latestPreflightFile = latestFile(androidLiveDir, /^preflight-.*\.json$/);
const latestPreflight = readJson(latestPreflightFile);
const latestEmulatorSmokeFile = latestFile(emulatorSmokeDir, /^emulator-smoke-.*\.json$/);
const latestEmulatorSmoke = readJson(latestEmulatorSmokeFile);
const requireAutoVideoLive = process.env.REQUIRE_AUTO_VIDEO_LIVE === "1";
const status = inferStatus(phase, primary, noArm, autoVideo, requireAutoVideoLive);

const report = {
  ok: status === "ready",
  generatedAt: Date.now(),
  status,
  finalReady: status === "ready",
  phase,
  androidLive: primary,
  androidNoArm: noArm,
  androidAutoVideo: autoVideo,
  requireAutoVideoLive,
  latestStageFinal,
  latestPreflight: latestPreflightFile
    ? {
        file: latestPreflightFile,
        status: latestPreflight?.status || null,
        blockers: latestPreflight?.blockers || [],
        currentPhaseReady: latestPreflight?.currentPhase?.ready ?? null,
        emulatorCanSatisfyFinalGate: latestPreflight?.emulatorDebug?.canSatisfyFinalGate ?? null,
      }
    : null,
  latestEmulatorSmoke: latestEmulatorSmokeFile
    ? {
        file: latestEmulatorSmokeFile,
        ok: latestEmulatorSmoke?.ok === true,
        physicalAndroidDevice: latestEmulatorSmoke?.verdict?.physicalAndroidDevice ?? null,
        phaseReadyForRelease: latestEmulatorSmoke?.verdict?.phaseReadyForRelease ?? null,
        canSatisfyFinalGate: latestEmulatorSmoke?.canSatisfyFinalGate ?? null,
      }
    : null,
  nextCommands: [...new Set(nextCommands(status, requireAutoVideoLive, autoVideo))],
};

console.log(JSON.stringify(report, null, 2));
