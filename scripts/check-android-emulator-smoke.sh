#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${ANDROID_EMULATOR_SMOKE_REPORT_DIR:-$ROOT_DIR/.local/android-emulator-smoke-reports}"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT_JSON="$REPORT_DIR/emulator-smoke-$TS.json"
REPORT_LOG="$REPORT_DIR/emulator-smoke-$TS.log"

AVD_NAME="${ANDROID_AVD_NAME:-}"
ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"

mkdir -p "$REPORT_DIR"
cd "$ROOT_DIR"

log() {
  printf '[check:android-emulator-smoke] %s\n' "$*" | tee -a "$REPORT_LOG"
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
  die "Android emulator binary not found. Set ANDROID_EMULATOR=/path/to/emulator."
}

ADB_BIN="$(adb_bin)"
EMULATOR_BIN="$(emulator_bin)"

choose_avd() {
  if [[ -n "$AVD_NAME" ]]; then
    printf '%s\n' "$AVD_NAME"
    return
  fi
  "$EMULATOR_BIN" -list-avds | awk 'NF { print; exit }'
}

device_state() {
  "$ADB_BIN" -s "$ANDROID_SERIAL" get-state 2>/dev/null || true
}

boot_completed() {
  "$ADB_BIN" -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true
}

start_emulator_if_needed() {
  local avd="$1"
  if [[ "$(device_state)" == "device" ]]; then
    log "emulator already connected: $ANDROID_SERIAL"
    return
  fi
  log "starting emulator avd=$avd serial=$ANDROID_SERIAL"
  nohup "$EMULATOR_BIN" \
    -avd "$avd" \
    -no-window \
    -no-audio \
    -no-snapshot-save \
    -gpu swiftshader_indirect \
    >"$REPORT_DIR/emulator-$TS.out" 2>&1 &
  echo "$!" >"$REPORT_DIR/emulator-$TS.pid"
}

wait_for_emulator() {
  local timeout="${ANDROID_EMULATOR_BOOT_TIMEOUT_SECONDS:-180}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if [[ "$(device_state)" == "device" && "$(boot_completed)" == "1" ]]; then
      log "emulator booted: $ANDROID_SERIAL"
      return
    fi
    sleep 3
  done
  "$ADB_BIN" devices -l | tee -a "$REPORT_LOG" || true
  die "emulator did not boot within ${timeout}s"
}

write_report() {
  local status="$1"
  local details_json="${2:-{}}"
  STATUS="$status" \
  DETAILS_JSON="$details_json" \
  DETAILS_JSON_FILE="${DETAILS_JSON_FILE:-}" \
  REPORT_JSON="$REPORT_JSON" \
  REPORT_LOG="$REPORT_LOG" \
  ANDROID_SERIAL="$ANDROID_SERIAL" \
  AVD_NAME="$AVD_NAME" \
  node <<'NODE'
const fs = require("node:fs");
let details = {};
try {
  const detailsFile = process.env.DETAILS_JSON_FILE || "";
  const rawDetails = detailsFile ? fs.readFileSync(detailsFile, "utf8") : (process.env.DETAILS_JSON || "{}");
  details = JSON.parse(rawDetails);
} catch {
  details = {
    rawDetails: process.env.DETAILS_JSON || "",
    rawDetailsFile: process.env.DETAILS_JSON_FILE || null,
  };
}
const report = {
  ok: process.env.STATUS === "ok",
  generatedAt: Date.now(),
  status: process.env.STATUS,
  avdName: process.env.AVD_NAME || null,
  androidSerial: process.env.ANDROID_SERIAL || null,
  canSatisfyFinalGate: false,
  purpose: "emulator-only install/pair/service-start smoke; never final physical-device evidence",
  ...details,
  reportFiles: {
    report: process.env.REPORT_JSON,
    log: process.env.REPORT_LOG,
    ...(details.reportFiles || {}),
  },
};
fs.writeFileSync(process.env.REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
NODE
}

doctor() {
  local avds selected current_state boot
  avds="$("$EMULATOR_BIN" -list-avds 2>/dev/null || true)"
  selected="$(choose_avd || true)"
  current_state="$(device_state)"
  boot="$(boot_completed)"
  AVDS="$avds" SELECTED="$selected" CURRENT_STATE="$current_state" BOOT="$boot" node <<'NODE'
const report = {
  ok: Boolean(process.env.SELECTED),
  avds: (process.env.AVDS || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  selectedAvd: process.env.SELECTED || null,
  currentState: process.env.CURRENT_STATE || null,
  bootCompleted: process.env.BOOT || null,
};
console.log(JSON.stringify(report));
NODE
}

run_smoke() {
  local avd
  avd="$(choose_avd)"
  [[ -n "$avd" ]] || die "no Android AVD found"
  AVD_NAME="$avd"
  start_emulator_if_needed "$avd"
  wait_for_emulator

  log "running live prepare against emulator-only report dir"
  ANDROID_SERIAL="$ANDROID_SERIAL" \
  ANDROID_LIVE_REPORT_DIR="$REPORT_DIR" \
  CL_A_ANDROID_DEVICE_NAME="ClawSense Emulator Smoke" \
  scripts/check-android-live.sh prepare

  log "collecting emulator-only report"
  ANDROID_SERIAL="$ANDROID_SERIAL" \
  ANDROID_LIVE_REPORT_DIR="$REPORT_DIR" \
  HUMAN_TTS_OK=0 \
  HUMAN_ANSWER_RELEVANT=0 \
  scripts/check-android-live.sh collect || true

  local latest_live
  latest_live="$(find "$REPORT_DIR" -name 'android-live-*.json' -type f -print0 | xargs -0 ls -t 2>/dev/null | head -n 1 || true)"
  if [[ -z "$latest_live" ]]; then
    write_report "failed" '{"failure":"android_live_report_missing"}'
    exit 1
  fi

  LATEST_LIVE="$latest_live" node <<'NODE'
const fs = require("node:fs");
const live = JSON.parse(fs.readFileSync(process.env.LATEST_LIVE, "utf8"));
if (live.androidDevice?.isEmulator !== true) {
  throw new Error("expected emulator live report to be marked androidDevice.isEmulator=true");
}
if (live.verdict?.physicalAndroidDevice !== false) {
  throw new Error("expected emulator live report to have physicalAndroidDevice=false");
}
if (live.verdict?.phaseReadyForRelease !== false) {
  throw new Error("expected emulator live report to have phaseReadyForRelease=false");
}
if (live.androidPackage?.packageName !== "ai.openclaw.clawsense.debug") {
  throw new Error("expected debug APK package to be installed in emulator smoke");
}
NODE

  LATEST_LIVE="$latest_live" node <<'NODE' >"$REPORT_DIR/details-$TS.json"
const fs = require("node:fs");
const live = JSON.parse(fs.readFileSync(process.env.LATEST_LIVE, "utf8"));
console.log(JSON.stringify({
  latestAndroidLive: process.env.LATEST_LIVE,
  androidDevice: live.androidDevice,
  androidPackage: live.androidPackage,
  verdict: live.verdict,
  host: live.host,
  reportFiles: {
    latestAndroidLive: process.env.LATEST_LIVE,
  },
}));
NODE
  DETAILS_JSON_FILE="$REPORT_DIR/details-$TS.json" write_report "ok"
}

usage() {
  cat <<'EOF'
Usage: scripts/check-android-emulator-smoke.sh <doctor|run|help>

This is emulator-only smoke coverage for install/pair/service-start.
It never satisfies the current stage final gate because final sign-off requires a physical Android device.

Environment:
  ANDROID_AVD_NAME=<name>                         Defaults to the first available AVD.
  ANDROID_SERIAL=emulator-5554
  ANDROID_EMULATOR=/path/to/emulator
  ANDROID_EMULATOR_BOOT_TIMEOUT_SECONDS=180
  ANDROID_EMULATOR_SMOKE_REPORT_DIR=.local/android-emulator-smoke-reports
EOF
}

cmd="${1:-doctor}"
case "$cmd" in
  doctor) doctor ;;
  run) run_smoke ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
