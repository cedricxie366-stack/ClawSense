#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${ANDROID_LIVE_REPORT_DIR:-$ROOT_DIR/.local/android-live-reports}"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT_JSON="$REPORT_DIR/android-live-$TS.json"
REPORT_LOG="$REPORT_DIR/android-live-$TS.log"
PREFLIGHT_JSON="$REPORT_DIR/preflight-$TS.json"
PREFLIGHT_ADB_OUT="$REPORT_DIR/preflight-adb-$TS.out"
PREFLIGHT_AVD_OUT="$REPORT_DIR/preflight-avds-$TS.out"
LOGCAT_OUT="$REPORT_DIR/logcat-$TS.out"
DEVICES_OUT="$REPORT_DIR/devices-$TS.out"
MEDIA_OUT="$REPORT_DIR/media-$TS.out"
EVIDENCE_OUT="$REPORT_DIR/video-evidence-$TS.out"
DEVICE_PROPS_OUT="$REPORT_DIR/device-props-$TS.out"
PACKAGE_OUT="$REPORT_DIR/package-$TS.out"
UI_XML_REMOTE="/sdcard/clawsense-window.xml"
UI_XML_OUT="$REPORT_DIR/window-$TS.xml"
SCREENSHOT_OUT="$REPORT_DIR/screenshot-$TS.png"

PKG="${CL_A_ANDROID_PACKAGE:-ai.openclaw.clawsense.debug}"
HOST="${CL_A_ANDROID_HOST:-http://127.0.0.1:18789}"
DEVICE_NAME="${CL_A_ANDROID_DEVICE_NAME:-ClawSense-Live-Validation}"
APP_APK="${CL_A_ANDROID_APK:-$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk}"

ACTION_START="ai.openclaw.clawsense.action.START"
ACTION_TRIGGER_ASSISTANT_QUERY="ai.openclaw.clawsense.action.TRIGGER_ASSISTANT_QUERY"
ACTION_STOP_ASSISTANT_SPEAKING="ai.openclaw.clawsense.action.STOP_ASSISTANT_SPEAKING"
ACTION_CAPTURE_VIDEO_CLIP="ai.openclaw.clawsense.action.CAPTURE_VIDEO_CLIP"

SERVICE_COMPONENT="$PKG/ai.openclaw.clawsense.service.SensorForegroundService"
MAIN_COMPONENT="$PKG/ai.openclaw.clawsense.MainActivity"
DEBUG_REPAIR_COMPONENT="$PKG/ai.openclaw.clawsense.debug.DebugSessionRepairReceiver"

mkdir -p "$REPORT_DIR"
cd "$ROOT_DIR"

log() {
  printf '[check:android-live] %s\n' "$*" | tee -a "$REPORT_LOG"
}

die() {
  log "error: $*"
  exit 1
}

adb_bin() {
  if [[ -n "${ADB:-}" ]]; then
    printf '%s\n' "$ADB"
    return
  fi
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return
  fi
  if [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
    printf '%s\n' "$HOME/Library/Android/sdk/platform-tools/adb"
    return
  fi
  die "adb not found. Set ADB=/path/to/adb."
}

ADB_BIN="$(adb_bin)"
ADB_ARGS=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB_ARGS=(-s "$ANDROID_SERIAL")
fi

adb_cmd() {
  if ((${#ADB_ARGS[@]} > 0)); then
    "$ADB_BIN" "${ADB_ARGS[@]}" "$@"
  else
    "$ADB_BIN" "$@"
  fi
}

emulator_bin() {
  if [[ -n "${ANDROID_EMULATOR:-}" ]]; then
    printf '%s\n' "$ANDROID_EMULATOR"
    return
  fi
  if command -v emulator >/dev/null 2>&1; then
    command -v emulator
    return
  fi
  if [[ -x "$HOME/Library/Android/sdk/emulator/emulator" ]]; then
    printf '%s\n' "$HOME/Library/Android/sdk/emulator/emulator"
    return
  fi
  true
}

device_lines() {
  "$ADB_BIN" devices -l | awk 'NR > 1 && $2 == "device" { print }'
}

require_device() {
  local count
  count="$(device_lines | wc -l | tr -d ' ')"
  if [[ "$count" == "0" ]]; then
    "$ADB_BIN" devices -l | tee -a "$REPORT_LOG" || true
    die "no authorized Android device connected"
  fi
  if [[ "$count" != "1" && -z "${ANDROID_SERIAL:-}" ]]; then
    "$ADB_BIN" devices -l | tee -a "$REPORT_LOG" || true
    die "multiple devices connected; set ANDROID_SERIAL"
  fi
}

run_logged() {
  log "run: $*"
  "$@" 2>&1 | tee -a "$REPORT_LOG"
}

capture_logged() {
  local out="$1"
  shift
  log "run: $*"
  "$@" >"$out" 2>&1 || true
  cat "$out" | tee -a "$REPORT_LOG"
}

capture_logcat() {
  if [[ "${LOGCAT_ALL_TAGS:-0}" == "1" ]]; then
    capture_logged "$LOGCAT_OUT" adb_cmd logcat -d -t "${LOGCAT_LINES:-5000}"
    return
  fi
  capture_logged "$LOGCAT_OUT" adb_cmd logcat -d -v time \
    -s ClawSenseService:D ClawSenseAudio:D ClawSenseCamera:D '*:S'
}

clear_logcat_if_needed() {
  local reason="$1"
  if [[ "${PRESERVE_LOGCAT:-0}" == "1" || "${CLEAR_LOGCAT:-1}" == "0" ]]; then
    log "preserve logcat for $reason"
    return
  fi
  run_logged adb_cmd logcat -c
}

latest_file() {
  local pattern="$1"
  find "$ROOT_DIR" -path "$pattern" -type f -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null \
    | head -n 1
}

latest_android_report_by_mode() {
  local mode="$1"
  node - "$REPORT_DIR" "$mode" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const mode = process.argv[3];
if (!dir || !fs.existsSync(dir)) {
  process.exit(0);
}
const records = [];
for (const name of fs.readdirSync(dir)) {
  if (!/^android-live-.*\.json$/.test(name)) continue;
  const file = path.join(dir, name);
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectsNoAssistantQuery = report?.verdict?.expectsNoAssistantQuery === true;
    const expectsAutoVideo = report?.verdict?.expectsAutoVideo === true;
    if (
      (mode === "no-arm" && expectsNoAssistantQuery) ||
      (mode === "auto-video" && expectsAutoVideo) ||
      (mode === "primary" && !expectsNoAssistantQuery && !expectsAutoVideo)
    ) {
      records.push({ file, generatedAt: Number(report.generatedAt || 0) });
    }
  } catch {
    // Ignore partial/invalid reports.
  }
}
records.sort((a, b) => b.generatedAt - a.generatedAt || b.file.localeCompare(a.file));
if (records[0]) {
  process.stdout.write(records[0].file);
}
NODE
}

extract_pair_token() {
  local input
  input="$(mktemp)"
  cat >"$input"
  local node_status=0
  PAIR_OUTPUT_FILE="$input" node <<'NODE' || node_status=$?
const fs = require("node:fs");
const raw = fs.readFileSync(process.env.PAIR_OUTPUT_FILE, "utf8");
const candidates = [];
for (let start = 0; start < raw.length; start += 1) {
  if (raw[start] !== "{") continue;
  let depth = 0;
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
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          candidates.push(JSON.parse(raw.slice(start, index + 1)));
        } catch {
          // Ignore banner fragments.
        }
        break;
      }
    }
  }
}
const token = candidates.find((item) => item?.ok === true && typeof item?.token === "string")?.token;
if (!token) {
  console.error("pair token not found in output");
  process.exit(2);
}
process.stdout.write(token);
NODE
  rm -f "$input"
  return "$node_status"
}

ensure_java_home() {
  if [[ -z "${JAVA_HOME:-}" && -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  fi
}

build_debug_apk() {
  if [[ "${SKIP_ANDROID_BUILD:-0}" == "1" ]]; then
    log "skip Android build because SKIP_ANDROID_BUILD=1"
    return
  fi
  ensure_java_home
  run_logged bash -lc "cd '$ROOT_DIR/android' && ./gradlew assembleDebug"
}

install_debug_apk() {
  if [[ "${SKIP_ANDROID_INSTALL:-0}" == "1" ]]; then
    log "skip Android install because SKIP_ANDROID_INSTALL=1"
    return
  fi
  [[ -f "$APP_APK" ]] || die "debug APK missing: $APP_APK"
  run_logged adb_cmd install -r "$APP_APK"
}

sync_host_runtime() {
  if [[ "${SYNC_LOCAL_OPENCLAW:-1}" == "1" ]]; then
    run_logged bash scripts/local-openclaw.sh setup
  fi
  run_logged bash scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '"keyframes"' --strict-json
  run_logged bash -lc "bash scripts/local-openclaw.sh gateway-restart || bash scripts/local-openclaw.sh gateway-start"
}

pair_debug_device() {
  local pair_raw token
  pair_raw="$(bash scripts/local-openclaw.sh pair 2>&1)"
  printf '%s\n' "$pair_raw" | tee -a "$REPORT_LOG"
  token="$(printf '%s\n' "$pair_raw" | extract_pair_token)"
  run_logged adb_cmd reverse tcp:18789 tcp:18789
  run_logged adb_cmd shell am broadcast \
    -n "$DEBUG_REPAIR_COMPONENT" \
    --es host "$HOST" \
    --es token "$token" \
    --es deviceName "$DEVICE_NAME"
  sleep "${PAIR_SETTLE_SECONDS:-2}"
}

debug_broadcast() {
  run_logged adb_cmd shell am broadcast -n "$DEBUG_REPAIR_COMPONENT" "$@"
}

grant_runtime_permissions() {
  local permissions=(
    android.permission.CAMERA
    android.permission.RECORD_AUDIO
    android.permission.POST_NOTIFICATIONS
  )
  for permission in "${permissions[@]}"; do
    adb_cmd shell pm grant "$PKG" "$permission" >/dev/null 2>&1 || true
  done
}

start_app_and_service() {
  run_logged adb_cmd shell am start -n "$MAIN_COMPONENT"
  debug_broadcast --ez startSensing true
}

prepare() {
  require_device
  log "repo=$ROOT_DIR"
  log "report_dir=$REPORT_DIR"
  build_debug_apk
  install_debug_apk
  sync_host_runtime
  grant_runtime_permissions
  pair_debug_device
  start_app_and_service
  sleep "${PREPARE_SETTLE_SECONDS:-8}"
  capture_logged "$DEVICES_OUT" bash scripts/local-openclaw.sh devices
  capture_logged "$MEDIA_OUT" bash scripts/local-openclaw.sh media-today
  log "prepared. Next manual checks:"
  log "  scripts/check-android-live.sh arm-query auto"
  log "  PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting"
  log "  PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts"
  log "  PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video"
  log "  HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect"
  log "  scripts/check-android-live.sh observe-ambient"
  log "  EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect"
}

doctor() {
  local phase_json android_live_json android_no_arm_json emulator_path
  "$ADB_BIN" devices -l >"$PREFLIGHT_ADB_OUT" 2>&1 || true
  cat "$PREFLIGHT_ADB_OUT" | tee -a "$REPORT_LOG"
  emulator_path="$(emulator_bin)"
  if [[ -n "$emulator_path" ]]; then
    "$emulator_path" -list-avds >"$PREFLIGHT_AVD_OUT" 2>&1 || true
  else
    : >"$PREFLIGHT_AVD_OUT"
  fi
  phase_json="$(latest_file "$ROOT_DIR/.local/current-phase-reports/current-phase-*.json" || true)"
  android_live_json="$(latest_android_report_by_mode primary || true)"
  android_no_arm_json="$(latest_android_report_by_mode no-arm || true)"
  android_auto_video_json="$(latest_android_report_by_mode auto-video || true)"
  ADB_BIN="$ADB_BIN" \
  ADB_OUT="$PREFLIGHT_ADB_OUT" \
  EMULATOR_BIN="$emulator_path" \
  EMULATOR_AVDS_OUT="$PREFLIGHT_AVD_OUT" \
  ANDROID_SERIAL="${ANDROID_SERIAL:-}" \
  APP_APK="$APP_APK" \
  PKG="$PKG" \
  PHASE_JSON="$phase_json" \
  ANDROID_LIVE_JSON="$android_live_json" \
  ANDROID_NO_ARM_JSON="$android_no_arm_json" \
  ANDROID_AUTO_VIDEO_JSON="$android_auto_video_json" \
  OPENCLAW_BIN="$ROOT_DIR/.local/openclaw/home/node_modules/.bin/openclaw" \
  OPENCLAW_CONFIG_PATH="$ROOT_DIR/.local/openclaw/state/openclaw.json" \
  PREFLIGHT_JSON="$PREFLIGHT_JSON" \
  node <<'NODE'
const fs = require("node:fs");

function read(path) {
  return path && fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}

function readJson(path) {
  if (!path || !fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const adbRaw = read(process.env.ADB_OUT);
const avdRaw = read(process.env.EMULATOR_AVDS_OUT);
const adbLines = adbRaw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("List of devices"));
const authorizedDevices = adbLines.filter((line) => /\bdevice\b/.test(line) && !/\bunauthorized\b|\boffline\b/.test(line));
const unauthorizedDevices = adbLines.filter((line) => /\bunauthorized\b/.test(line));
const offlineDevices = adbLines.filter((line) => /\boffline\b/.test(line));
const availableAvds = avdRaw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => !/^error:/i.test(line));
const phase = readJson(process.env.PHASE_JSON);
const live = readJson(process.env.ANDROID_LIVE_JSON);
const noArm = readJson(process.env.ANDROID_NO_ARM_JSON);
const autoVideo = readJson(process.env.ANDROID_AUTO_VIDEO_JSON);
const appApkExists = fs.existsSync(process.env.APP_APK || "");
const openclawBinExists = fs.existsSync(process.env.OPENCLAW_BIN || "");
const openclawConfigExists = fs.existsSync(process.env.OPENCLAW_CONFIG_PATH || "");
const phaseReady =
  phase?.ok === true &&
  phase?.acceptance?.phaseState === "ready-to-close" &&
  phase?.acceptance?.passedCriteria === phase?.acceptance?.totalCriteria;
const phaseGeneratedAt = Number(phase?.generatedAt || 0);
const liveGeneratedAt = Number(live?.generatedAt || 0);
const liveFreshAgainstPhase =
  liveGeneratedAt > 0 && phaseGeneratedAt > 0 ? liveGeneratedAt >= phaseGeneratedAt : liveGeneratedAt > 0;
const noArmGeneratedAt = Number(noArm?.generatedAt || 0);
const noArmFreshAgainstPhase =
  noArmGeneratedAt > 0 && phaseGeneratedAt > 0 ? noArmGeneratedAt >= phaseGeneratedAt : noArmGeneratedAt > 0;
const autoVideoGeneratedAt = Number(autoVideo?.generatedAt || 0);
const autoVideoFreshAgainstPhase =
  autoVideoGeneratedAt > 0 && phaseGeneratedAt > 0
    ? autoVideoGeneratedAt >= phaseGeneratedAt
    : autoVideoGeneratedAt > 0;
const liveReady =
  live?.ok === true &&
  liveFreshAgainstPhase &&
  live?.verdict?.physicalAndroidDevice === true &&
  live?.verdict?.voiceLoopObserved === true &&
  live?.verdict?.ttsStatus === "pass" &&
  live?.verdict?.humanTtsOk === true &&
  live?.verdict?.humanAnswerRelevant === true &&
  live?.verdict?.stopTtsObserved === true &&
  live?.verdict?.videoStatus === "upload-observed" &&
  live?.verdict?.authStable === true &&
  live?.verdict?.phaseReadyForRelease === true &&
  Number(live?.host?.videoEvidenceGroups || 0) > 0 &&
  Number(live?.host?.videoTranscriptSpans || 0) > 0 &&
  Number(live?.host?.videoKeyframeDetails || 0) > 0;
const noArmReady =
  noArm?.ok === true &&
  noArmFreshAgainstPhase &&
  noArm?.verdict?.expectsNoAssistantQuery === true &&
  noArm?.verdict?.noArmAmbientQueryClean === true &&
  noArm?.verdict?.noArmAmbientQueryPollution === false;
const autoVideoReady =
  autoVideo?.ok === true &&
  autoVideoFreshAgainstPhase &&
  autoVideo?.verdict?.expectsAutoVideo === true &&
  autoVideo?.verdict?.physicalAndroidDevice === true &&
  autoVideo?.verdict?.autoVideoObserved === true &&
  autoVideo?.verdict?.autoVideoLiveReady === true &&
  autoVideo?.verdict?.authStable === true &&
  Number(autoVideo?.host?.videoEvidenceGroups || 0) > 0 &&
  Number(autoVideo?.host?.videoKeyframeDetails || 0) > 0;
const requireAutoVideoLive = process.env.REQUIRE_AUTO_VIDEO_LIVE === "1";

let status = "ready-for-live-validation";
const blockers = [];
const nextCommands = [];
const optionalDebugCommands = [];

function pushAutoVideoCommands() {
  nextCommands.push("# enable auto-video evidence enhancement on the Android UI");
  nextCommands.push("# play/say a trigger phrase such as: 看这里，这页 PPT 是重点，帮我看一下这段演示。");
  nextCommands.push("EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect");
  nextCommands.push("REQUIRE_AUTO_VIDEO_LIVE=1 npm run check:stage-final");
}

if (!openclawBinExists || !openclawConfigExists) {
  status = "needs-local-openclaw-setup";
  blockers.push("repo-local OpenClaw runtime is missing or incomplete");
  nextCommands.push("bash scripts/local-openclaw.sh setup");
}
if (!phaseReady) {
  status = status === "ready-for-live-validation" ? "needs-current-phase" : status;
  blockers.push("current phase host/fixture report is missing or not ready-to-close");
  nextCommands.push("SYNC_LOCAL_OPENCLAW=0 CHECK_ANDROID=0 npm run check:phase");
}
if (!appApkExists) {
  status = status === "ready-for-live-validation" ? "needs-debug-apk" : status;
  blockers.push("debug APK is missing");
  nextCommands.push("cd android && JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew assembleDebug");
}
if (unauthorizedDevices.length > 0) {
  status = "device-unauthorized";
  blockers.push("Android device is connected but unauthorized");
  nextCommands.push("adb devices -l  # then accept the USB debugging authorization prompt on the phone");
}
if (offlineDevices.length > 0) {
  status = "device-offline";
  blockers.push("Android device is offline");
  nextCommands.push("adb kill-server && adb start-server && adb devices -l");
}
if (authorizedDevices.length === 0) {
  status = status === "ready-for-live-validation" ? "waiting-for-device" : status;
  blockers.push("no authorized Android device connected");
  nextCommands.push("adb devices -l");
  nextCommands.push("connect a physical Android device and accept the USB debugging authorization prompt");
  nextCommands.push("npm run check:android-live:doctor");
  nextCommands.push("npm run check:android-live");
  if (process.env.EMULATOR_BIN && availableAvds.length > 0) {
    optionalDebugCommands.push(
      `${process.env.EMULATOR_BIN} -avd ${availableAvds[0]} # optional emulator-only debug; not final evidence`,
    );
    optionalDebugCommands.push(
      "npm run check:android-emulator:smoke # optional install/pair/service-start debug; never release sign-off",
    );
  }
}
if (authorizedDevices.length > 1 && !process.env.ANDROID_SERIAL) {
  status = "needs-android-serial";
  blockers.push("multiple authorized Android devices connected; ANDROID_SERIAL is required");
  nextCommands.push("ANDROID_SERIAL=<serial> npm run check:android-live");
}
if (liveReady && noArmReady && (!requireAutoVideoLive || autoVideoReady)) {
  status = "ready-for-stage-final";
  nextCommands.length = 0;
  nextCommands.push(requireAutoVideoLive ? "REQUIRE_AUTO_VIDEO_LIVE=1 npm run check:stage-final" : "npm run check:stage-final");
} else if (liveReady && noArmReady && requireAutoVideoLive && !autoVideoReady && status === "ready-for-live-validation") {
  status = "needs-auto-video-live-validation";
  pushAutoVideoCommands();
} else if (live && !liveFreshAgainstPhase && status === "ready-for-live-validation") {
  status = "stale-live-report";
  blockers.push("latest Android live report is older than the current phase report");
  nextCommands.push("npm run check:android-live");
  nextCommands.push("scripts/check-android-live.sh arm-query auto");
  nextCommands.push("PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting");
  nextCommands.push("PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts");
  nextCommands.push("PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video");
  nextCommands.push("HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect");
} else if (noArm && !noArmFreshAgainstPhase && status === "ready-for-live-validation") {
  status = "stale-no-arm-live-report";
  blockers.push("latest no-arm Android live report is older than the current phase report");
  nextCommands.push("scripts/check-android-live.sh observe-ambient");
  nextCommands.push("EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect");
} else if (status === "ready-for-live-validation") {
  if (liveReady && !noArmReady) {
    status = "needs-no-arm-live-validation";
    nextCommands.push("scripts/check-android-live.sh observe-ambient");
    nextCommands.push("EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect");
  } else {
    nextCommands.push("npm run check:android-live");
    nextCommands.push("scripts/check-android-live.sh arm-query auto");
    nextCommands.push("PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting");
    nextCommands.push("PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts");
    nextCommands.push("PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video");
    nextCommands.push("HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect");
    if (!noArmReady) {
      nextCommands.push("scripts/check-android-live.sh observe-ambient");
      nextCommands.push("EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect");
    }
  }
}
if (
  requireAutoVideoLive &&
  !autoVideoReady &&
  authorizedDevices.length > 0 &&
  phaseReady &&
  appApkExists &&
  status !== "needs-auto-video-live-validation" &&
  status !== "ready-for-stage-final"
) {
  pushAutoVideoCommands();
}

const report = {
  ok: true,
  generatedAt: Date.now(),
  status,
  blockers,
  nextCommands: [...new Set(nextCommands)],
  requireAutoVideoLive,
  android: {
    adbBin: process.env.ADB_BIN,
    androidSerial: process.env.ANDROID_SERIAL || null,
    authorizedDeviceCount: authorizedDevices.length,
    unauthorizedDeviceCount: unauthorizedDevices.length,
    offlineDeviceCount: offlineDevices.length,
    authorizedDevices,
    unauthorizedDevices,
    offlineDevices,
  },
  emulatorDebug: {
    emulatorBin: process.env.EMULATOR_BIN || null,
    emulatorBinExists: Boolean(process.env.EMULATOR_BIN),
    availableAvds,
    availableAvdCount: availableAvds.length,
    mayHelpDebugInstallAndPairing: availableAvds.length > 0,
    canSatisfyFinalGate: false,
    optionalDebugCommands,
  },
  app: {
    packageName: process.env.PKG,
    apkPath: process.env.APP_APK,
    apkExists: appApkExists,
  },
  localOpenClaw: {
    openclawBin: process.env.OPENCLAW_BIN,
    openclawBinExists,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    configExists: openclawConfigExists,
  },
  currentPhase: {
    report: process.env.PHASE_JSON || null,
    ready: phaseReady,
    generatedAt: phaseGeneratedAt || null,
    phaseState: phase?.acceptance?.phaseState ?? null,
    passedCriteria: phase?.acceptance?.passedCriteria ?? null,
    totalCriteria: phase?.acceptance?.totalCriteria ?? null,
  },
  latestAndroidLive: {
    report: process.env.ANDROID_LIVE_JSON || null,
    ready: liveReady,
    generatedAt: liveGeneratedAt || null,
    freshAgainstPhase: liveFreshAgainstPhase,
    verdict: live?.verdict ?? null,
    androidDevice: live?.androidDevice ?? null,
    androidPackage: live?.androidPackage ?? null,
  },
  latestAndroidNoArm: {
    report: process.env.ANDROID_NO_ARM_JSON || null,
    ready: noArmReady,
    generatedAt: noArmGeneratedAt || null,
    freshAgainstPhase: noArmFreshAgainstPhase,
    verdict: noArm?.verdict ?? null,
  },
  latestAndroidAutoVideo: {
    report: process.env.ANDROID_AUTO_VIDEO_JSON || null,
    ready: autoVideoReady,
    generatedAt: autoVideoGeneratedAt || null,
    freshAgainstPhase: autoVideoFreshAgainstPhase,
    verdict: autoVideo?.verdict ?? null,
  },
  reportFiles: {
    preflight: process.env.PREFLIGHT_JSON,
    adb: process.env.ADB_OUT,
    avds: process.env.EMULATOR_AVDS_OUT,
  },
};

fs.writeFileSync(process.env.PREFLIGHT_JSON, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
NODE
  log "preflight=$PREFLIGHT_JSON"
}

arm_query() {
  require_device
  local mode="${1:-auto}"
  local upper
  upper="$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')"
  case "$upper" in
    AUTO|MEETING|DESK) ;;
    *) die "mode must be auto, meeting, or desk" ;;
  esac
  clear_logcat_if_needed "arm-query"
  debug_broadcast \
    --ez triggerAssistantQuery true \
    --es assistantModeHint "$upper"
  log "query armed in $upper mode. Speak one short question, then wait for VAD silence and TTS."
}

wait_for_logcat_pattern() {
  local pattern="$1"
  local attempts="${2:-16}"
  local delay_seconds="${3:-0.25}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if adb_cmd logcat -d -v time \
      -s ClawSenseDebugRepair:I ClawSenseService:D ClawSenseAudio:D '*:S' 2>/dev/null \
      | grep -q "$pattern"; then
      return 0
    fi
    sleep "$delay_seconds"
  done
  return 1
}

tap_query() {
  require_device
  local mode="${1:-auto}"
  local label
  case "$(printf '%s' "$mode" | tr '[:upper:]' '[:lower:]')" in
    auto) label="自动" ;;
    meeting) label="会议" ;;
    desk) label="工位" ;;
    *) die "mode must be auto, meeting, or desk" ;;
  esac
  clear_logcat_if_needed "tap-query"
  run_logged adb_cmd shell am start -n "$MAIN_COMPONENT"
  sleep 0.5
  tap_visible_text "$label"
  sleep 0.3
  tap_visible_text "问实时助手"
  if wait_for_logcat_pattern "Assistant query armed"; then
    sleep 0.6
  else
    log "warning: did not observe Assistant query armed in logcat before screenshot"
  fi
  capture_screenshot
  log "query armed via real Android UI in $mode mode. Speak one short question, then wait for VAD silence and TTS."
}

stop_tts() {
  require_device
  debug_broadcast --ez stopAssistantSpeaking true
}

capture_video() {
  require_device
  clear_logcat_if_needed "capture-video"
  debug_broadcast --ez captureVideoClip true
  log "manual 6s video capture triggered. Wait ~15s, then run: scripts/check-android-live.sh collect"
  log "for final primary live report, run this command with PRESERVE_LOGCAT=1 after voice/TTS evidence"
}

inject_throttle() {
  require_device
  local duration_ms="${1:-60000}"
  local queue_depth="${2:-24}"
  case "$duration_ms" in
    ''|*[!0-9]*) die "duration_ms must be a positive integer" ;;
  esac
  case "$queue_depth" in
    ''|*[!0-9]*) die "queue_depth must be a non-negative integer" ;;
  esac
  clear_logcat_if_needed "inject-throttle"
  debug_broadcast \
    --ez injectThrottle true \
    --el throttleDurationMs "$duration_ms" \
    --ei throttleQueueDepth "$queue_depth"
  log "debug throttle injected for ${duration_ms}ms queueDepth=$queue_depth."
  log "Use this only with debug APK validation. Wait for sensor activity, then run: scripts/check-android-live.sh collect"
}

observe_ambient_no_query() {
  require_device
  run_logged adb_cmd logcat -c
  log "ambient no-query window started. Do NOT tap assistant query."
  log "Play interview/video/meeting audio for 30-90s, then run: EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect"
}

dump_ui() {
  require_device
  adb_cmd shell uiautomator dump "$UI_XML_REMOTE" >/dev/null 2>&1 || true
  adb_cmd pull "$UI_XML_REMOTE" "$UI_XML_OUT" >/dev/null 2>&1 || true
}

capture_screenshot() {
  require_device
  adb_cmd exec-out screencap -p >"$SCREENSHOT_OUT" 2>/dev/null || true
  if [[ -s "$SCREENSHOT_OUT" ]]; then
    log "screenshot=$SCREENSHOT_OUT"
  else
    rm -f "$SCREENSHOT_OUT"
    log "screenshot capture skipped or failed"
  fi
}

tap_visible_text() {
  local label="$1"
  local attempt bounds center
  for attempt in 1 2 3 4; do
    dump_ui
    bounds="$(
      UI_XML_OUT="$UI_XML_OUT" TAP_LABEL="$label" node <<'NODE'
const fs = require("node:fs");
const xml = fs.existsSync(process.env.UI_XML_OUT)
  ? fs.readFileSync(process.env.UI_XML_OUT, "utf8")
  : "";
const label = process.env.TAP_LABEL || "";
const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`<node[^>]*text="${escaped}"[^>]*bounds="\\[([0-9]+),([0-9]+)\\]\\[([0-9]+),([0-9]+)\\]"`, "g");
for (const match of xml.matchAll(re)) {
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  if (right > left && bottom > top) {
    process.stdout.write(`${left},${top},${right},${bottom}`);
    process.exit(0);
  }
}
process.exit(1);
NODE
    )" || true
    if [[ -n "$bounds" ]]; then
      center="$(
        BOUNDS="$bounds" node <<'NODE'
const [left, top, right, bottom] = String(process.env.BOUNDS || "").split(",").map(Number);
process.stdout.write(`${Math.round((left + right) / 2)} ${Math.round((top + bottom) / 2)}`);
NODE
      )"
      log "tap UI text \"$label\" at $center bounds=$bounds"
      adb_cmd shell input tap $center
      return 0
    fi
    log "UI text \"$label\" not visible; scrolling toward assistant controls (attempt $attempt)"
    adb_cmd shell input swipe 720 2500 720 900 450 >/dev/null 2>&1 || true
    sleep 0.5
  done
  die "UI text not visible after scrolling: $label"
}

collect() {
  require_device
  capture_logcat
  {
    printf 'serial='
    adb_cmd get-serialno 2>/dev/null || true
    printf 'ro.kernel.qemu='
    adb_cmd shell getprop ro.kernel.qemu 2>/dev/null || true
    printf 'ro.product.manufacturer='
    adb_cmd shell getprop ro.product.manufacturer 2>/dev/null || true
    printf 'ro.product.model='
    adb_cmd shell getprop ro.product.model 2>/dev/null || true
    printf 'ro.product.device='
    adb_cmd shell getprop ro.product.device 2>/dev/null || true
    printf 'ro.build.fingerprint='
    adb_cmd shell getprop ro.build.fingerprint 2>/dev/null || true
  } >"$DEVICE_PROPS_OUT"
  cat "$DEVICE_PROPS_OUT" | tee -a "$REPORT_LOG"
  capture_logged "$PACKAGE_OUT" adb_cmd shell dumpsys package "$PKG"
  capture_logged "$DEVICES_OUT" bash scripts/local-openclaw.sh devices
  capture_logged "$MEDIA_OUT" bash scripts/local-openclaw.sh media-today
  capture_logged "$EVIDENCE_OUT" bash scripts/local-openclaw.sh evidence-video
  dump_ui
  capture_screenshot
  LOGCAT_OUT="$LOGCAT_OUT" \
  DEVICES_OUT="$DEVICES_OUT" \
  MEDIA_OUT="$MEDIA_OUT" \
  EVIDENCE_OUT="$EVIDENCE_OUT" \
  DEVICE_PROPS_OUT="$DEVICE_PROPS_OUT" \
  PACKAGE_OUT="$PACKAGE_OUT" \
  UI_XML_OUT="$UI_XML_OUT" \
  SCREENSHOT_OUT="$SCREENSHOT_OUT" \
  REPORT_JSON="$REPORT_JSON" \
  HUMAN_TTS_OK="${HUMAN_TTS_OK:-0}" \
  HUMAN_ANSWER_RELEVANT="${HUMAN_ANSWER_RELEVANT:-0}" \
  EXPECT_NO_ASSISTANT_QUERY="${EXPECT_NO_ASSISTANT_QUERY:-0}" \
  node scripts/summarize-android-live-report.mjs
  log "report=$REPORT_JSON"
}

usage() {
  cat <<'EOF'
Usage: scripts/check-android-live.sh <command> [args]

Commands:
  doctor               Non-destructive preflight report for Android live validation readiness.
  prepare              Build/install debug APK, sync local OpenClaw, adb reverse, debug-pair, start service.
  arm-query [mode]     Trigger one assistant query via service action. mode: auto|meeting|desk.
  tap-query [mode]     Trigger one assistant query by tapping the real Android UI. mode: auto|meeting|desk.
  observe-ambient      Clear logcat before a no-query ambient audio window.
  stop-tts             Stop current local Android TTS playback.
  capture-video        Trigger manual 6s video clip capture.
  inject-throttle [duration_ms] [queue_depth]
                       Debug APK only: inject temporary capture throttle for validation.
  collect              Save logcat/UI screenshot/host media/evidence into .local/android-live-reports.
  help                 Show this help.

Environment:
  ADB=/path/to/adb
  ANDROID_SERIAL=<serial>                 Required when multiple devices are connected.
  CL_A_ANDROID_HOST=http://127.0.0.1:18789
  CL_A_ANDROID_PACKAGE=ai.openclaw.clawsense.debug
  HUMAN_TTS_OK=1                         Set only after a human confirms spoken answer was complete enough.
  HUMAN_ANSWER_RELEVANT=1                Set only after a human confirms the answer matched the question/evidence.
  EXPECT_AUTO_VIDEO=1                    Mark collect output as an auto-video validation report, not primary live.
  EXPECT_NO_ASSISTANT_QUERY=1            Mark collect output as a no-arm ambient report.
  PRESERVE_LOGCAT=1                      Append this action to the current evidence window.
  CLEAR_LOGCAT=0                         Alias for PRESERVE_LOGCAT=1.
  SKIP_ANDROID_BUILD=1
  SKIP_ANDROID_INSTALL=1
  SYNC_LOCAL_OPENCLAW=0

Recommended flow:
  scripts/check-android-live.sh doctor
  scripts/check-android-live.sh prepare
  scripts/check-android-live.sh arm-query auto
  # or use the true UI path:
  # scripts/check-android-live.sh tap-query auto
  # speak: 过去4小时我们聊了什么？
  # wait for TTS completed, then append more evidence into the same primary report:
  PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting
  # speak: 刚才讨论的重点是什么？
  PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts
  PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video
  HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect
  scripts/check-android-live.sh observe-ambient
  # play interview/video audio without tapping assistant; then:
  EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect
EOF
}

cmd="${1:-prepare}"
shift || true
case "$cmd" in
  doctor|preflight) doctor "$@" ;;
  prepare) prepare "$@" ;;
  arm-query) arm_query "$@" ;;
  tap-query|ui-query) tap_query "$@" ;;
  observe-ambient|observe-ambient-no-query|ambient-no-query) observe_ambient_no_query "$@" ;;
  stop-tts) stop_tts "$@" ;;
  capture-video) capture_video "$@" ;;
  inject-throttle|debug-throttle) inject_throttle "$@" ;;
  collect) collect "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
