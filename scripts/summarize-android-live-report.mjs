#!/usr/bin/env node
import fs from "node:fs";

function read(filePath) {
  return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function count(raw, pattern) {
  return (raw.match(new RegExp(pattern, "g")) || []).length;
}

function extractJson(raw, predicate) {
  const candidates = [];
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const ch = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") {
        const open = stack.pop();
        if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) break;
        if (stack.length === 0) {
          try {
            candidates.push(JSON.parse(raw.slice(start, index + 1)));
          } catch {
            // Ignore CLI banners.
          }
          break;
        }
      }
    }
  }
  return candidates.find((candidate) => predicate(candidate));
}

function matchOne(raw, pattern) {
  const match = raw.match(pattern);
  return match ? String(match[1] || "").trim() : "";
}

function parseDeviceProps(raw) {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

export function summarizeAndroidLiveReport(env = process.env) {
  const logcat = read(env.LOGCAT_OUT);
  const devicesRaw = read(env.DEVICES_OUT);
  const mediaRaw = read(env.MEDIA_OUT);
  const evidenceRaw = read(env.EVIDENCE_OUT);
  const devicePropsRaw = read(env.DEVICE_PROPS_OUT);
  const packageRaw = read(env.PACKAGE_OUT);
  const uiXml = read(env.UI_XML_OUT);
  const screenshotCaptured = Boolean(env.SCREENSHOT_OUT && fs.existsSync(env.SCREENSHOT_OUT));

  const devices = extractJson(devicesRaw, (item) => item?.ok === true && Array.isArray(item?.devices));
  const media = extractJson(
    mediaRaw,
    (item) => item?.counts && (item?.ok === true || typeof item?.date === "string"),
  );
  const evidence = extractJson(evidenceRaw, (item) => item?.ok === true && item?.evidenceBundle);
  const uiTexts = [...uiXml.matchAll(/text="([^"]*)"/g)]
    .map((match) => match[1])
    .filter(Boolean)
    .slice(0, 80);

  const logs = {
    assistantQueryArmed: count(logcat, "Assistant query armed"),
    assistantQueryCaptured: count(logcat, "Assistant query clip captured"),
    assistantQuerySubmitting: count(logcat, "Assistant query submitting"),
    assistantQueryAnswered: count(logcat, "Assistant query answered"),
    assistantQueryTimedOut: count(logcat, "Assistant query recording timed out"),
    assistantAudioRecheckAttempted: count(logcat, "audioRecheckAttempted=true"),
    assistantAudioRecheckRefreshed: count(logcat, "audioRecheckRefreshed=true"),
    assistantTtsCompleted: count(logcat, "Assistant TTS completed"),
    assistantTtsFailed: count(logcat, "Assistant TTS failed"),
    assistantTtsStopRequested: count(logcat, "Assistant TTS stop requested"),
    longAssistantQueryRejected: count(logcat, "Rejecting long assistant query candidate"),
    continuedAmbientRejected: count(logcat, "Rejecting continued ambient assistant query candidate"),
    assistantPhaseDrops: count(logcat, "Dropping ambient audio clip during assistant phase"),
    echoDrainDrops: count(logcat, "Dropping ambient audio clip inside assistant echo drain"),
    audioUploadSucceeded: count(logcat, "Audio upload succeeded"),
    imageUploadSucceeded: count(logcat, "Image upload succeeded"),
    videoUploadSucceeded: count(logcat, "Video upload succeeded"),
    stillCaptureDeferred: count(logcat, "Deferring still capture due to throttle"),
    lowSignalAudioDeferred: count(logcat, "Deferring low-signal audio clip due to throttle"),
    autoVideoCaptureRequested: count(logcat, "Auto video clip capture requested"),
    autoVideoUploadSucceeded: count(logcat, "Auto video upload succeeded"),
    autoVideoThrottled: count(logcat, "Skipping auto-video directive.*capture throttle"),
    http401: count(logcat, "HTTP 401|unauthorized"),
    http503: count(logcat, "HTTP 503|ingest_queue_full"),
  };
  const videoEvidenceGroups = Array.isArray(evidence?.evidenceBundle?.videoEvidenceGroups)
    ? evidence.evidenceBundle.videoEvidenceGroups
    : [];
  const host = {
    deviceCount: devices?.count ?? null,
    mediaCounts: media?.counts ?? null,
    videoEvidenceGroups: videoEvidenceGroups.length,
    videoTranscriptSpans: evidence?.evidenceBundle?.transcriptSpans?.length ?? null,
    videoKeyframeDetails: videoEvidenceGroups.reduce(
      (sum, group) => sum + (Array.isArray(group?.keyframeDetails) ? group.keyframeDetails.length : 0),
      0,
    ),
  };
  const mediaEvents = Array.isArray(media?.events) ? media.events : [];
  const ambientAudioTranscriptCount = mediaEvents.filter(
    (event) => event?.modality === "audio" && typeof event?.transcript === "string" && event.transcript.trim(),
  ).length;

  const deviceProps = parseDeviceProps(devicePropsRaw);
  const serial = String(deviceProps.serial || "");
  const manufacturer = String(deviceProps["ro.product.manufacturer"] || "");
  const model = String(deviceProps["ro.product.model"] || "");
  const qemu = String(deviceProps["ro.kernel.qemu"] || "").trim() === "1";
  const isEmulator =
    qemu ||
    serial.startsWith("emulator-") ||
    /google sdk|sdk_gphone|emulator|android sdk/i.test(`${manufacturer} ${model}`);
  const androidPackage = {
    packageName: matchOne(packageRaw, /Package \[([^\]]+)\]/),
    versionName: matchOne(packageRaw, /\bversionName=([^\s]+)/),
    versionCode: Number(matchOne(packageRaw, /\bversionCode=(\d+)/)) || null,
    firstInstallTime: matchOne(packageRaw, /\bfirstInstallTime=([^\n]+)/),
    lastUpdateTime: matchOne(packageRaw, /\blastUpdateTime=([^\n]+)/),
  };
  const voiceLoopObserved =
    logs.assistantQueryArmed > 0 &&
    logs.assistantQueryCaptured > 0 &&
    logs.assistantQuerySubmitting > 0 &&
    logs.assistantQueryAnswered > 0;
  const assistantQueryLogObserved =
    logs.assistantQueryArmed > 0 ||
    logs.assistantQueryCaptured > 0 ||
    logs.assistantQuerySubmitting > 0 ||
    logs.assistantQueryAnswered > 0;
  const queryCaptureStatus = voiceLoopObserved
    ? "answered"
    : logs.assistantQueryTimedOut > 0 && logs.assistantQueryCaptured === 0
      ? "armed-but-no-query-audio"
      : logs.assistantQueryArmed === 0 && ambientAudioTranscriptCount > 0
        ? "ambient-asr-ok-but-no-assistant-query"
        : logs.assistantQueryCaptured > 0 && logs.assistantQueryAnswered === 0
          ? "query-audio-captured-but-no-answer"
          : logs.assistantQueryArmed > 0
            ? "assistant-query-incomplete"
            : "not-observed";
  const expectsNoAssistantQuery = env.EXPECT_NO_ASSISTANT_QUERY === "1";
  const expectsAutoVideo = env.EXPECT_AUTO_VIDEO === "1";
  const ttsStatus =
    logs.assistantTtsCompleted > 0
      ? "pass"
      : logs.assistantTtsFailed > 0
        ? "degraded-text-answer-only"
        : "missing";
  const videoStatus =
    logs.videoUploadSucceeded > 0
      ? "upload-observed"
      : Number(host.videoEvidenceGroups || 0) > 0 && Number(host.videoKeyframeDetails || 0) > 0
        ? "host-evidence-present"
        : "missing";
  const primaryPhaseReadyForRelease =
    !expectsNoAssistantQuery &&
    !expectsAutoVideo &&
    !isEmulator &&
    Number(host.deviceCount || 0) > 0 &&
    voiceLoopObserved &&
    ttsStatus === "pass" &&
    env.HUMAN_TTS_OK === "1" &&
    env.HUMAN_ANSWER_RELEVANT === "1" &&
    logs.assistantTtsStopRequested > 0 &&
    videoStatus === "upload-observed" &&
    Number(host.videoEvidenceGroups || 0) > 0 &&
    Number(host.videoTranscriptSpans || 0) > 0 &&
    Number(host.videoKeyframeDetails || 0) > 0 &&
    logs.http401 === 0;
  const autoVideoLiveReady =
    expectsAutoVideo &&
    !isEmulator &&
    Number(host.deviceCount || 0) > 0 &&
    (logs.autoVideoCaptureRequested > 0 || logs.autoVideoUploadSucceeded > 0) &&
    logs.autoVideoUploadSucceeded > 0 &&
    videoStatus === "upload-observed" &&
    Number(host.videoEvidenceGroups || 0) > 0 &&
    Number(host.videoKeyframeDetails || 0) > 0 &&
    logs.http401 === 0;

  return {
    ok: true,
    generatedAt: Date.now(),
    verdict: {
      physicalAndroidDevice: !isEmulator,
      hostDeviceSeen: Number(host.deviceCount || 0) > 0,
      voiceLoopObserved,
      queryCaptureStatus,
      audioRecheckAttempted: logs.assistantAudioRecheckAttempted > 0,
      audioRecheckRefreshed: logs.assistantAudioRecheckRefreshed > 0,
      ttsStatus,
      humanTtsOk: env.HUMAN_TTS_OK === "1",
      humanAnswerRelevant: env.HUMAN_ANSWER_RELEVANT === "1",
      expectsNoAssistantQuery,
      expectsAutoVideo,
      noArmAmbientQueryClean: expectsNoAssistantQuery ? !assistantQueryLogObserved : null,
      noArmAmbientQueryPollution: expectsNoAssistantQuery && assistantQueryLogObserved,
      stopTtsObserved: logs.assistantTtsStopRequested > 0,
      videoStatus,
      authStable: logs.http401 === 0,
      backpressureObserved: logs.http503 > 0,
      queueThrottleObserved:
        logs.stillCaptureDeferred > 0 ||
        logs.lowSignalAudioDeferred > 0 ||
        logs.autoVideoThrottled > 0,
      autoVideoObserved: logs.autoVideoCaptureRequested > 0 || logs.autoVideoUploadSucceeded > 0,
      autoVideoThrottled: logs.autoVideoThrottled > 0,
      autoVideoLiveReady: expectsAutoVideo ? autoVideoLiveReady : null,
      needsHumanTtsJudgment: env.HUMAN_TTS_OK !== "1" || env.HUMAN_ANSWER_RELEVANT !== "1",
      phaseReadyForRelease: expectsNoAssistantQuery ? false : primaryPhaseReadyForRelease,
    },
    logs,
    androidDevice: {
      serial,
      manufacturer,
      model,
      device: deviceProps["ro.product.device"] || "",
      fingerprint: deviceProps["ro.build.fingerprint"] || "",
      isEmulator,
    },
    androidPackage,
    host,
    audioDiagnostics: {
      ambientAudioTranscriptCount,
      assistantQueryTimedOut: logs.assistantQueryTimedOut,
      interpretation:
        queryCaptureStatus === "ambient-asr-ok-but-no-assistant-query"
          ? "Environment ASR produced transcripts, but no assistant query was armed/captured in this evidence window."
          : queryCaptureStatus === "armed-but-no-query-audio"
            ? "The assistant entered listening mode, but VAD did not emit a usable query clip before timeout."
            : queryCaptureStatus === "query-audio-captured-but-no-answer"
              ? "The phone captured a query clip, but the host did not return an assistant answer."
              : null,
    },
    ui: {
      dumped: uiXml.length > 0,
      screenshotCaptured,
      textSample: uiTexts,
    },
    reportFiles: {
      logcat: env.LOGCAT_OUT,
      devices: env.DEVICES_OUT,
      media: env.MEDIA_OUT,
      evidence: env.EVIDENCE_OUT,
      deviceProps: env.DEVICE_PROPS_OUT,
      package: env.PACKAGE_OUT,
      ui: env.UI_XML_OUT,
      screenshot: screenshotCaptured ? env.SCREENSHOT_OUT : null,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = summarizeAndroidLiveReport(process.env);
  if (!process.env.REPORT_JSON) {
    console.error("REPORT_JSON is required");
    process.exit(2);
  }
  fs.writeFileSync(process.env.REPORT_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
