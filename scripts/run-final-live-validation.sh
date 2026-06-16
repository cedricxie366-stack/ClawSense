#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[final-live] %s\n' "$*"
}

die() {
  log "error: $*"
  exit 1
}

require_tty() {
  if [[ ! -t 0 ]]; then
    die "interactive terminal is required; use docs/agents/final-stage-live-validation-agent-prompt.md for manual/non-interactive validation"
  fi
}

prompt_enter() {
  local message="$1"
  printf '\n[final-live] %s\n' "$message"
  read -r -p "[final-live] Press Enter to continue..." _
}

confirm_yes() {
  local message="$1"
  local answer
  printf '\n[final-live] %s\n' "$message"
  read -r -p "[final-live] Type YES to confirm: " answer
  [[ "$answer" == "YES" ]]
}

run_step() {
  log "run: $*"
  "$@"
}

require_tty

cat <<'EOF'
[final-live] This guided flow produces the two Android reports required by npm run check:stage-final:
[final-live] 1. primary live report: voice query + TTS + stop TTS + manual video upload.
[final-live] 2. no-arm ambient report: interview/video audio without tapping assistant query.
[final-live]
[final-live] It will NOT set HUMAN_TTS_OK/HUMAN_ANSWER_RELEVANT unless you type YES.
[final-live] Do not use emulator results as release evidence.
EOF

prompt_enter "Connect and unlock a physical Android device, then accept USB debugging if prompted."

run_step npm run check:stage-final:doctor
run_step npm run check:android-live:doctor

prompt_enter "The next step builds/installs the debug APK, syncs repo-local OpenClaw, pairs over adb reverse, and starts sensing."
run_step npm run check:android-live

prompt_enter "Primary query A: after the phone arms, say: 过去4小时我们聊了什么？"
run_step scripts/check-android-live.sh arm-query auto

prompt_enter "Wait until the phone has answered and TTS playback has completed or clearly started."

prompt_enter "Primary query B: after the phone arms, say: 刚才讨论的重点是什么？ Keep this in the same logcat window."
run_step env PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting

prompt_enter "When the phone is currently speaking, continue to send stop-tts into the same primary evidence window."
run_step env PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts

prompt_enter "Trigger manual 6s video capture. Keep the phone aimed at a visible scene/screen."
run_step env PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video

sleep_seconds="${VIDEO_SETTLE_SECONDS:-15}"
log "waiting ${sleep_seconds}s for video upload and host evidence"
sleep "$sleep_seconds"

human_flags=()
if confirm_yes "Did the phone speak the answer completely enough, and was the answer relevant to the questions/evidence?"; then
  human_flags=(HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1)
  log "human confirmation accepted for primary live collect"
else
  log "human confirmation was not provided; collecting primary report without pass flags"
fi

if [[ "${#human_flags[@]}" -gt 0 ]]; then
  env "${human_flags[@]}" scripts/check-android-live.sh collect
else
  scripts/check-android-live.sh collect
fi

prompt_enter "No-arm ambient validation: the next command clears logcat. Do NOT tap assistant query afterwards."
run_step scripts/check-android-live.sh observe-ambient

prompt_enter "Play 30-90 seconds of interview/video/meeting audio near the phone. Do not tap the assistant query button. Continue only after playback ends."
run_step env EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect

log "refreshing final status"
run_step npm run check:stage-final:doctor

log "running final hard gate"
run_step npm run check:stage-final
run_step npm run check:stage-final:index

log "final live validation completed"
