#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT_DIR"

log() {
  printf '[check:android-live:fixtures] %s\n' "$*"
}

if awk '
  /^clear_logcat_if_needed\(\) \{/ { in_fn = 1; next }
  in_fn && /^\}/ { in_fn = 0 }
  in_fn { print }
' scripts/check-android-live.sh | grep -q 'clear_logcat_if_needed'; then
  echo "clear_logcat_if_needed must not call itself" >&2
  exit 1
fi

if ! awk '
  /^clear_logcat_if_needed\(\) \{/ { in_fn = 1; next }
  in_fn && /^\}/ { in_fn = 0 }
  in_fn { print }
' scripts/check-android-live.sh | grep -q 'adb_cmd logcat -c'; then
  echo "clear_logcat_if_needed must clear logcat through adb" >&2
  exit 1
fi

if ! awk '
  /^adb_cmd\(\) \{/ { in_fn = 1; next }
  in_fn && /^\}/ { in_fn = 0 }
  in_fn { print }
' scripts/check-android-live.sh | grep -q '\${#ADB_ARGS\[@\]}'; then
  echo "adb_cmd must guard empty ADB_ARGS under set -u" >&2
  exit 1
fi

if grep -q 'CL_A_ANDROID_DEVICE_NAME:-.* ' scripts/check-android-live.sh; then
  echo "default CL_A_ANDROID_DEVICE_NAME must not contain spaces; adb shell may split it" >&2
  exit 1
fi

if ! grep -q 'minVoicedMs = AUDIO_SESSION_MIN_VOICED_MS' \
  android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt; then
  echo "SensorForegroundService must pass a live-query-friendly minVoicedMs to AndroidAudioSensorHal" >&2
  exit 1
fi

if ! grep -q 'AUDIO_SESSION_MIN_VOICED_MS = 256L' \
  android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt; then
  echo "AUDIO_SESSION_MIN_VOICED_MS should stay short enough for one-sentence assistant queries" >&2
  exit 1
fi

if ! grep -q 'fun beginAssistantQueryCapture' \
  android/app/src/main/java/ai/openclaw/clawsense/sensors/AndroidAudioSensorHal.kt; then
  echo "AndroidAudioSensorHal must expose dedicated assistant-query capture" >&2
  exit 1
fi

if ! grep -q 'Assistant query capture started' \
  android/app/src/main/java/ai/openclaw/clawsense/sensors/AndroidAudioSensorHal.kt; then
  echo "AndroidAudioSensorHal should log assistant-query capture starts for live debugging" >&2
  exit 1
fi

if ! grep -q 'audioHal.beginAssistantQueryCapture' \
  android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt; then
  echo "SensorForegroundService must use dedicated assistant-query capture" >&2
  exit 1
fi

LOGCAT_OUT="$TMP_DIR/logcat.out"
DEVICES_OUT="$TMP_DIR/devices.out"
MEDIA_OUT="$TMP_DIR/media.out"
EVIDENCE_OUT="$TMP_DIR/evidence.out"
DEVICE_PROPS_OUT="$TMP_DIR/device-props.out"
PACKAGE_OUT="$TMP_DIR/package.out"
UI_XML_OUT="$TMP_DIR/window.xml"
REPORT_JSON="$TMP_DIR/android-live.json"
SUMMARY_OUT="$TMP_DIR/summary.out"
REPORT_NO_HUMAN_JSON="$TMP_DIR/android-live-no-human.json"
REPORT_EMULATOR_JSON="$TMP_DIR/android-live-emulator.json"
REPORT_AUTH_JSON="$TMP_DIR/android-live-auth.json"
REPORT_NO_RECHECK_JSON="$TMP_DIR/android-live-no-recheck.json"
REPORT_MISSING_VIDEO_JSON="$TMP_DIR/android-live-missing-video.json"
REPORT_NO_STOP_JSON="$TMP_DIR/android-live-no-stop.json"
REPORT_AMBIENT_NO_QUERY_JSON="$TMP_DIR/android-live-ambient-no-query.json"
REPORT_AMBIENT_POLLUTED_JSON="$TMP_DIR/android-live-ambient-polluted.json"
REPORT_THROTTLE_JSON="$TMP_DIR/android-live-throttle.json"
REPORT_AUTO_VIDEO_JSON="$TMP_DIR/android-live-auto-video.json"
DOCTOR_REPORT_DIR="$TMP_DIR/doctor-live-reports"

run_summary() {
  local report_json="$1"
  local logcat_out="${2:-$LOGCAT_OUT}"
  local device_props_out="${3:-$DEVICE_PROPS_OUT}"
  local human_tts_ok="${4:-1}"
  local human_answer_relevant="${5:-1}"
  local expect_no_assistant_query="${6:-0}"
  local expect_auto_video="${7:-0}"
  LOGCAT_OUT="$logcat_out" \
  DEVICES_OUT="$DEVICES_OUT" \
  MEDIA_OUT="$MEDIA_OUT" \
  EVIDENCE_OUT="$EVIDENCE_OUT" \
  DEVICE_PROPS_OUT="$device_props_out" \
  PACKAGE_OUT="$PACKAGE_OUT" \
  UI_XML_OUT="$UI_XML_OUT" \
  REPORT_JSON="$report_json" \
  HUMAN_TTS_OK="$human_tts_ok" \
  HUMAN_ANSWER_RELEVANT="$human_answer_relevant" \
  EXPECT_NO_ASSISTANT_QUERY="$expect_no_assistant_query" \
  EXPECT_AUTO_VIDEO="$expect_auto_video" \
  node scripts/summarize-android-live-report.mjs
}

cat >"$LOGCAT_OUT" <<'EOF'
05-31 17:00:00.000 D/ClawSenseService: Assistant query armed mode=AUTO
05-31 17:00:01.000 D/ClawSenseService: Assistant query clip captured durationMs=2500 bytes=8000
05-31 17:00:02.000 D/ClawSenseService: Assistant query submitting mode=AUTO durationMs=2500 bytes=8000
05-31 17:00:03.000 D/ClawSenseService: Assistant query answered mode=AUTO source=recent-context action=none queryTextLen=9 answerLen=42 spokenLen=18 sttProvider=local sttFailure=none sttRewrite=none rawQueryLen=9 audioRecheckAttempted=true audioRecheckRefreshed=true audioRecheckTranscripts=1/1
05-31 17:00:04.000 D/ClawSenseService: Assistant TTS completed utterance=assistant-answer
05-31 17:00:05.000 D/ClawSenseService: Assistant TTS stop requested
05-31 17:00:06.000 D/ClawSenseService: Audio upload succeeded
05-31 17:00:07.000 D/ClawSenseService: Image upload succeeded
05-31 17:00:08.000 D/ClawSenseService: Video upload succeeded
EOF

cat >"$DEVICES_OUT" <<'EOF'
{
  "ok": true,
  "count": 1,
  "devices": [
    { "deviceId": "fixture-device", "name": "Fixture Phone" }
  ]
}
EOF

cat >"$MEDIA_OUT" <<'EOF'
{
  "ok": true,
  "counts": {
    "total": 4,
    "audio": 1,
    "image": 2,
    "video": 1
  }
}
EOF

cat >"$EVIDENCE_OUT" <<'EOF'
{
  "ok": true,
  "evidenceBundle": {
    "videoEvidenceGroups": [
      {
        "videoRequestId": "fixture-video",
        "keyframeDetails": [
          { "eventId": "keyframe-1" }
        ]
      }
    ],
    "transcriptSpans": [
      { "eventId": "audio-1", "text": "fixture transcript" }
    ]
  }
}
EOF

cat >"$DEVICE_PROPS_OUT" <<'EOF'
serial=fixture-serial
ro.kernel.qemu=0
ro.product.manufacturer=OnePlus
ro.product.model=PDEM10
ro.product.device=PDEM10
ro.build.fingerprint=fixture/fingerprint
EOF

cat >"$PACKAGE_OUT" <<'EOF'
Package [ai.openclaw.clawsense.debug] (123):
  versionCode=42 minSdk=26 targetSdk=35
  versionName=0.1.0-fixture
  firstInstallTime=2026-05-31 17:00:00
  lastUpdateTime=2026-05-31 17:01:00
EOF

cat >"$UI_XML_OUT" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node text="ClawSense"/>
  <node text="最近回答"/>
</hierarchy>
EOF

run_summary "$REPORT_JSON" >"$SUMMARY_OUT"
cat "$SUMMARY_OUT"

REPORT_JSON="$REPORT_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertAtLeast(actual, expected, label) {
  if (!Number.isFinite(actual) || actual < expected) {
    throw new Error(`${label}: expected >= ${expected}, got ${actual}`);
  }
}
assertEqual(report.verdict.physicalAndroidDevice, true, "physicalAndroidDevice");
assertEqual(report.verdict.hostDeviceSeen, true, "hostDeviceSeen");
assertEqual(report.verdict.voiceLoopObserved, true, "voiceLoopObserved");
assertEqual(report.verdict.audioRecheckAttempted, true, "audioRecheckAttempted");
assertEqual(report.verdict.audioRecheckRefreshed, true, "audioRecheckRefreshed");
assertEqual(report.verdict.ttsStatus, "pass", "ttsStatus");
assertEqual(report.verdict.humanTtsOk, true, "humanTtsOk");
assertEqual(report.verdict.humanAnswerRelevant, true, "humanAnswerRelevant");
assertEqual(report.verdict.stopTtsObserved, true, "stopTtsObserved");
assertEqual(report.verdict.videoStatus, "upload-observed", "videoStatus");
assertEqual(report.verdict.authStable, true, "authStable");
assertEqual(report.verdict.phaseReadyForRelease, true, "phaseReadyForRelease");
assertEqual(report.androidPackage.versionName, "0.1.0-fixture", "versionName");
assertEqual(report.androidPackage.versionCode, 42, "versionCode");
assertAtLeast(report.host.videoEvidenceGroups, 1, "videoEvidenceGroups");
assertAtLeast(report.host.videoTranscriptSpans, 1, "videoTranscriptSpans");
assertAtLeast(report.host.videoKeyframeDetails, 1, "videoKeyframeDetails");
NODE

run_summary "$REPORT_NO_HUMAN_JSON" "$LOGCAT_OUT" "$DEVICE_PROPS_OUT" 0 0 >/dev/null
REPORT_JSON="$REPORT_NO_HUMAN_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.voiceLoopObserved !== true) throw new Error("voice loop should still be observed");
if (report.verdict.ttsStatus !== "pass") throw new Error("TTS status should still pass");
if (report.verdict.humanTtsOk !== false) throw new Error("humanTtsOk should be false without human confirmation");
if (report.verdict.humanAnswerRelevant !== false) throw new Error("humanAnswerRelevant should be false without human confirmation");
if (report.verdict.needsHumanTtsJudgment !== true) throw new Error("needsHumanTtsJudgment should be true");
if (report.verdict.phaseReadyForRelease !== false) throw new Error("phaseReadyForRelease must not pass without human confirmation");
NODE

cat >"$TMP_DIR/device-props-emulator.out" <<'EOF'
serial=emulator-5554
ro.kernel.qemu=1
ro.product.manufacturer=Google
ro.product.model=sdk_gphone64_arm64
ro.product.device=emu64a
ro.build.fingerprint=google/sdk_gphone64_arm64/emulator
EOF
run_summary "$REPORT_EMULATOR_JSON" "$LOGCAT_OUT" "$TMP_DIR/device-props-emulator.out" 1 1 >/dev/null
REPORT_JSON="$REPORT_EMULATOR_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.physicalAndroidDevice !== false) throw new Error("emulator must not count as a physical Android device");
if (report.androidDevice.isEmulator !== true) throw new Error("androidDevice.isEmulator should be true");
NODE

cp "$LOGCAT_OUT" "$TMP_DIR/logcat-auth.out"
cat >>"$TMP_DIR/logcat-auth.out" <<'EOF'
05-31 17:00:09.000 D/ClawSenseService: Heartbeat failed: HTTP 401: {"ok":false,"error":"unauthorized"}
EOF
run_summary "$REPORT_AUTH_JSON" "$TMP_DIR/logcat-auth.out" "$DEVICE_PROPS_OUT" 1 1 >/dev/null
REPORT_JSON="$REPORT_AUTH_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.authStable !== false) throw new Error("authStable should be false after HTTP 401");
if (report.verdict.phaseReadyForRelease !== false) throw new Error("phaseReadyForRelease must fail when auth is unstable");
if (report.logs.http401 < 1) throw new Error("http401 counter should detect auth failure");
NODE

sed -e 's/ audioRecheckAttempted=true//g' -e 's/ audioRecheckRefreshed=true//g' "$LOGCAT_OUT" >"$TMP_DIR/logcat-no-recheck.out"
run_summary "$REPORT_NO_RECHECK_JSON" "$TMP_DIR/logcat-no-recheck.out" "$DEVICE_PROPS_OUT" 1 1 >/dev/null
REPORT_JSON="$REPORT_NO_RECHECK_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.voiceLoopObserved !== true) throw new Error("voice loop should remain observed without audio recheck logs");
if (report.verdict.audioRecheckAttempted !== false) throw new Error("audioRecheckAttempted should be false when diagnostics are absent");
if (report.verdict.audioRecheckRefreshed !== false) throw new Error("audioRecheckRefreshed should be false when diagnostics are absent");
NODE

sed '/Video upload succeeded/d' "$LOGCAT_OUT" >"$TMP_DIR/logcat-missing-video.out"
run_summary "$REPORT_MISSING_VIDEO_JSON" "$TMP_DIR/logcat-missing-video.out" "$DEVICE_PROPS_OUT" 1 1 >/dev/null
REPORT_JSON="$REPORT_MISSING_VIDEO_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.voiceLoopObserved !== true) throw new Error("voice loop should remain observed without video upload");
if (report.verdict.videoStatus !== "host-evidence-present") throw new Error(`expected host-evidence-present, got ${report.verdict.videoStatus}`);
if (report.verdict.phaseReadyForRelease !== false) throw new Error("phaseReadyForRelease must fail without observed Android video upload");
NODE

sed '/Assistant TTS stop requested/d' "$LOGCAT_OUT" >"$TMP_DIR/logcat-no-stop.out"
run_summary "$REPORT_NO_STOP_JSON" "$TMP_DIR/logcat-no-stop.out" "$DEVICE_PROPS_OUT" 1 1 >/dev/null
REPORT_JSON="$REPORT_NO_STOP_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.voiceLoopObserved !== true) throw new Error("voice loop should remain observed without stop-tts");
if (report.verdict.stopTtsObserved !== false) throw new Error("stopTtsObserved should be false without stop log");
if (report.verdict.phaseReadyForRelease !== false) throw new Error("phaseReadyForRelease must fail without stop-tts evidence");
NODE

cat >"$TMP_DIR/logcat-ambient-no-query.out" <<'EOF'
05-31 17:10:00.000 D/ClawSenseService: Audio clip ready. session=conv-fixture-video segment=1 boundary=silence capturedAt=1780228200000 durationMs=8200 voicedMs=5600 silenceMs=2440 bytes=262144
05-31 17:10:01.000 D/ClawSenseService: Uploading audio clip capture-1780228200000.wav capturedAt=1780228200000 bytes=262144 note=csAudio:v2 session=conv-fixture-video segment=1 sessionStart=1780228200000 boundary=silence clipMs=8200 voicedMs=5600 peakRms=0.071 continued=0
05-31 17:10:02.000 D/ClawSenseService: Audio upload succeeded
05-31 17:10:03.000 D/ClawSenseService: Image upload succeeded
EOF
run_summary "$REPORT_AMBIENT_NO_QUERY_JSON" "$TMP_DIR/logcat-ambient-no-query.out" "$DEVICE_PROPS_OUT" 0 0 1 >/dev/null
REPORT_JSON="$REPORT_AMBIENT_NO_QUERY_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.expectsNoAssistantQuery !== true) throw new Error("expectsNoAssistantQuery should be true");
if (report.verdict.noArmAmbientQueryClean !== true) throw new Error("ambient no-arm window should be clean");
if (report.verdict.noArmAmbientQueryPollution !== false) throw new Error("no-arm pollution should be false");
if (report.verdict.voiceLoopObserved !== false) throw new Error("ambient-only window must not count as a voice loop");
NODE

cat >"$TMP_DIR/logcat-ambient-polluted.out" <<'EOF'
05-31 17:11:00.000 D/ClawSenseService: Audio upload succeeded
05-31 17:11:01.000 D/ClawSenseService: Assistant query clip captured mode=AUTO durationMs=8200 bytes=262144
05-31 17:11:02.000 D/ClawSenseService: Assistant query submitting mode=AUTO durationMs=8200 bytes=262144
05-31 17:11:03.000 D/ClawSenseService: Assistant query answered mode=AUTO source=recent-context action=none queryTextLen=52 answerLen=80 spokenLen=30
EOF
run_summary "$REPORT_AMBIENT_POLLUTED_JSON" "$TMP_DIR/logcat-ambient-polluted.out" "$DEVICE_PROPS_OUT" 0 0 1 >/dev/null
REPORT_JSON="$REPORT_AMBIENT_POLLUTED_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.noArmAmbientQueryClean !== false) throw new Error("polluted no-arm window should fail clean verdict");
if (report.verdict.noArmAmbientQueryPollution !== true) throw new Error("pollution should be detected");
if (report.verdict.phaseReadyForRelease !== false) throw new Error("phaseReadyForRelease must fail in no-arm polluted mode");
NODE

cat >"$TMP_DIR/logcat-throttle.out" <<'EOF'
05-31 17:12:00.000 D/ClawSenseService: Deferring still capture due to throttle level=SEVERE reason=analysis_queue_severe nextInMs=60000
05-31 17:12:01.000 D/ClawSenseService: Deferring low-signal audio clip due to throttle level=SEVERE reason=analysis_queue_severe durationMs=3972 note=csAudio:v2 session=conv-throttle segment=1 clipMs=3972 voicedMs=512 peakRms=0.021 continued=0
05-31 17:12:02.000 D/ClawSenseService: Skipping auto-video directive id=directive-fixture; capture throttle level=ELEVATED reason=analysis_queue_elevated
05-31 17:12:03.000 D/ClawSenseService: Heartbeat failed: HTTP 503: {"ok":false,"error":"ingest_queue_full"}
EOF
run_summary "$REPORT_THROTTLE_JSON" "$TMP_DIR/logcat-throttle.out" "$DEVICE_PROPS_OUT" 0 0 1 >/dev/null
REPORT_JSON="$REPORT_THROTTLE_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.backpressureObserved !== true) throw new Error("HTTP 503 should be reported as backpressureObserved");
if (report.verdict.queueThrottleObserved !== true) throw new Error("queueThrottleObserved should detect Android throttle logs");
if (report.verdict.autoVideoThrottled !== true) throw new Error("autoVideoThrottled should be true when directive is skipped by throttle");
if (report.logs.stillCaptureDeferred < 1) throw new Error("stillCaptureDeferred log count should be detected");
if (report.logs.lowSignalAudioDeferred < 1) throw new Error("lowSignalAudioDeferred log count should be detected");
if (report.logs.autoVideoThrottled < 1) throw new Error("autoVideoThrottled log count should be detected");
if (report.verdict.autoVideoObserved !== false) throw new Error("throttled auto video should not count as captured/uploaded");
NODE

cat >"$TMP_DIR/logcat-auto-video.out" <<'EOF'
05-31 17:13:00.000 D/ClawSenseService: Auto video clip capture requested directiveId=directive-positive reason=visual_reference
05-31 17:13:01.000 D/ClawSenseService: Auto video upload succeeded directiveId=directive-positive
05-31 17:13:02.000 D/ClawSenseService: Video upload succeeded
EOF
run_summary "$REPORT_AUTO_VIDEO_JSON" "$TMP_DIR/logcat-auto-video.out" "$DEVICE_PROPS_OUT" 0 0 0 1 >/dev/null
REPORT_JSON="$REPORT_AUTO_VIDEO_JSON" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.REPORT_JSON, "utf8"));
if (report.verdict.expectsAutoVideo !== true) throw new Error("positive auto-video report should set expectsAutoVideo=true");
if (report.verdict.autoVideoObserved !== true) throw new Error("autoVideoObserved should detect positive auto-video logs");
if (report.verdict.autoVideoLiveReady !== true) throw new Error("autoVideoLiveReady should pass for positive auto-video evidence");
if (report.logs.autoVideoCaptureRequested < 1) throw new Error("autoVideoCaptureRequested log count should be detected");
if (report.logs.autoVideoUploadSucceeded < 1) throw new Error("autoVideoUploadSucceeded log count should be detected");
if (report.logs.videoUploadSucceeded < 1) throw new Error("Video upload succeeded should still be counted");
if (report.verdict.autoVideoThrottled !== false) throw new Error("positive auto video must not be marked throttled");
if (report.verdict.phaseReadyForRelease !== false) throw new Error("auto-video-only report must not count as primary phaseReadyForRelease");
NODE

mkdir -p "$DOCTOR_REPORT_DIR"
cp "$REPORT_JSON" "$DOCTOR_REPORT_DIR/android-live-primary.json"
cp "$REPORT_AMBIENT_NO_QUERY_JSON" "$DOCTOR_REPORT_DIR/android-live-no-arm-newer.json"
cp "$REPORT_AUTO_VIDEO_JSON" "$DOCTOR_REPORT_DIR/android-live-auto-video-newer.json"
ANDROID_LIVE_REPORT_DIR="$DOCTOR_REPORT_DIR" bash scripts/check-android-live.sh doctor >/dev/null
DOCTOR_PREFLIGHT="$(ls -t "$DOCTOR_REPORT_DIR"/preflight-*.json | head -n1)"
DOCTOR_PREFLIGHT="$DOCTOR_PREFLIGHT" PRIMARY_REPORT="$DOCTOR_REPORT_DIR/android-live-primary.json" NO_ARM_REPORT="$DOCTOR_REPORT_DIR/android-live-no-arm-newer.json" AUTO_VIDEO_REPORT="$DOCTOR_REPORT_DIR/android-live-auto-video-newer.json" node <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.env.DOCTOR_PREFLIGHT, "utf8"));
if (report.latestAndroidLive?.report !== process.env.PRIMARY_REPORT) {
  throw new Error(`doctor should select primary live report separately, got ${report.latestAndroidLive?.report}`);
}
if (report.latestAndroidNoArm?.report !== process.env.NO_ARM_REPORT) {
  throw new Error(`doctor should select no-arm live report separately, got ${report.latestAndroidNoArm?.report}`);
}
if (report.latestAndroidNoArm?.verdict?.expectsNoAssistantQuery !== true) {
  throw new Error("doctor no-arm verdict should preserve expectsNoAssistantQuery=true");
}
if (report.latestAndroidAutoVideo?.report !== process.env.AUTO_VIDEO_REPORT) {
  throw new Error(`doctor should select auto-video live report separately, got ${report.latestAndroidAutoVideo?.report}`);
}
if (report.latestAndroidAutoVideo?.verdict?.expectsAutoVideo !== true) {
  throw new Error("doctor auto-video verdict should preserve expectsAutoVideo=true");
}
NODE

log "ok"
