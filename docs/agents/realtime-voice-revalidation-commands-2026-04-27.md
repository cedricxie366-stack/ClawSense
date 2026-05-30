# Realtime Voice Revalidation Commands

Date: 2026-04-27

Purpose: after fixing `assistant-query-stt-empty` diagnostics and Android local TTS initialization, use these commands to re-run the realtime voice validation with a real Android device.

## 0. Setup

Run from the Mac host:

```bash
cd /Users/cedric/Documents/ClawSense

export ADB="$HOME/Library/Android/sdk/platform-tools/adb"
export PKG="ai.openclaw.clawsense.debug"
export TS="$(date +%Y%m%d-%H%M%S)"
export REPORT="docs/agents/realtime-voice-revalidation-report-$TS.md"
export LOG="/tmp/clawsense-realtime-voice-$TS.log"
printf '%s\n' "$REPORT" > /tmp/clawsense-current-report-path
printf '%s\n' "$LOG" > /tmp/clawsense-current-log-path

cat > "$REPORT" <<EOF
# Realtime Voice Revalidation Report

- GeneratedAt: $(date)
- Device:
- APK:
- Runtime: repo-local OpenClaw

EOF
```

## 1. Precheck

```bash
{
  echo "## Precheck"
  echo
  echo "### ADB"
  "$ADB" devices -l
  echo

  echo "### APK And Permissions"
  "$ADB" shell dumpsys package "$PKG" \
    | rg 'versionName|android.permission\.(CAMERA|RECORD_AUDIO|POST_NOTIFICATIONS): granted' || true
  echo

  echo "### TTS Engines"
  echo "default=$("$ADB" shell settings get secure tts_default_synth 2>/dev/null | tr -d '\r' || true)"
  "$ADB" shell cmd package query-services -a android.intent.action.TTS_SERVICE 2>/dev/null || true
  echo

  echo "### Local Gateway"
  scripts/local-openclaw.sh openclaw gateway status --json
  echo

  echo "### ClawSense Local Config"
  node - <<'NODE'
const fs=require('fs');
const p='.local/openclaw/state/openclaw.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
const c=((((j.plugins||{}).entries||{}).clawsense)||{}).config||{};
console.log(JSON.stringify({
  publicBaseUrl:c.publicBaseUrl||null,
  hasOpenaiApiKey:Boolean(c.openaiApiKey),
  openaiBaseUrl:c.openaiBaseUrl||null,
  visionProvider:c.visionProvider||null,
  visionModel:c.visionModel||null,
  sttFallbackModel:c.sttFallbackModel||null
}, null, 2));
NODE
  echo

  echo "### Devices"
  scripts/local-openclaw.sh devices || true
  echo
} | tee -a "$REPORT"
```

Pass criteria:

- ADB shows one `device`.
- `CAMERA / RECORD_AUDIO / POST_NOTIFICATIONS` are `granted=true`.
- Gateway status is `running`.
- `sttFallbackModel` should be set for a real STT pass. For DashScope, expected value is `qwen3-asr-flash`. If model config is empty, mark STT as config-degraded.

## 2. Host Route Checks

```bash
TOKEN=$(node - <<'NODE'
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('.local/openclaw/state/openclaw.json','utf8'));
console.log(j.gateway?.auth?.token || '');
NODE
)

{
  echo "## Host Route Checks"
  echo

  echo "### /assistant/query GET should be 405"
  curl -sS -m 3 -i http://127.0.0.1:18789/api/clawsense/assistant/query | sed -n '1,12p'
  echo

  echo "### /recent-context"
  curl -sS -m 5 \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:18789/api/clawsense/recent-context?windowHint=last_60s&modeHint=auto&question=%E6%88%91%E7%8E%B0%E5%9C%A8%E5%9C%A8%E7%9C%8B%E4%BB%80%E4%B9%88" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({ok:j.ok, sceneSummary:j.sceneSummary, counts:j.counts, keys:Object.keys(j)}, null, 2));})'
  echo

  echo "### /followups"
  curl -sS -m 5 \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:18789/api/clawsense/followups?scope=today&focus=what_happened" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({ok:j.ok, evidenceFollowUpTargets:j.evidenceFollowUpTargets?.length ?? 0, topPrompts:j.topPrompts ?? []}, null, 2));})'
  echo
} | tee -a "$REPORT"
```

Pass criteria:

- `/assistant/query` returns `405 Method Not Allowed` for GET.
- `/recent-context` returns `ok=true`.
- `/followups` returns `ok=true`.

## 3. UI Helper Functions

Create a reusable helper file:

```bash
cat > /tmp/clawsense-ui-helpers.sh <<'BASH'
dump_clawsense_ui() {
  "$ADB" shell uiautomator dump /sdcard/clawsense-window.xml >/dev/null
  "$ADB" pull /sdcard/clawsense-window.xml /tmp/clawsense-window.xml >/dev/null
}

print_clawsense_ui_text() {
  dump_clawsense_ui
  node - <<'NODE'
const fs=require('fs');
const xml=fs.readFileSync('/tmp/clawsense-window.xml','utf8');
console.log([...xml.matchAll(/text="([^"]*)"/g)].map(m=>m[1]).filter(Boolean).join('\n'));
NODE
}

tap_ask_realtime_assistant() {
  dump_clawsense_ui
  read X Y < <(node - <<'NODE'
const fs=require('fs');
const xml=fs.readFileSync('/tmp/clawsense-window.xml','utf8');
const patterns = [
  /<node[^>]*text="问实时助手"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
  /<node[^>]*text="启动感知服务"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/
];
for (const pattern of patterns) {
  const m=xml.match(pattern);
  if (m) {
    const n=m.slice(1).map(Number);
    console.log(`${Math.round((n[0]+n[2])/2)} ${Math.round((n[1]+n[3])/2)}`);
    process.exit(0);
  }
}
console.error('button_not_found');
process.exit(1);
NODE
)
  "$ADB" shell input tap "$X" "$Y"
}

open_clawsense_app() {
  "$ADB" shell monkey -p "$PKG" 1 >/dev/null
  sleep 2
  print_clawsense_ui_text
}
BASH

source /tmp/clawsense-ui-helpers.sh
```

Then open the app:

```bash
open_clawsense_app | tee -a "$REPORT"
```

If the service is not running, tap `启动感知服务` manually or via the helper once, wait for `就绪中`, then continue.

## 4. Validation A: Empty Query Timeout

```bash
{
  echo "## Validation A: Empty Query Timeout"
  echo
  "$ADB" logcat -c
  tap_ask_realtime_assistant
  sleep 15
  echo "### UI After Timeout"
  print_clawsense_ui_text
  echo
  echo "### Logs"
  "$ADB" logcat -d -t 1500 \
    | rg -i 'Assistant query|Assistant TTS|ClawSenseService' || true
  echo
} | tee -a "$REPORT"
```

Pass criteria:

- Log includes `Assistant query armed`.
- Log includes `Assistant query recording timed out`.
- UI returns to `就绪中`.
- UI shows the timeout guidance.

## 5. Validation B: Human Voice Query

Start the log watcher in one terminal:

```bash
cd /Users/cedric/Documents/ClawSense
export ADB="$HOME/Library/Android/sdk/platform-tools/adb"
export LOG="$(cat /tmp/clawsense-current-log-path 2>/dev/null || echo "/tmp/clawsense-realtime-voice-$(date +%Y%m%d-%H%M%S).log")"
printf '%s\n' "$LOG" > /tmp/clawsense-current-log-path

"$ADB" logcat -c
"$ADB" logcat \
  | rg --line-buffered 'Assistant query armed|Assistant query clip captured|Assistant query submitting|Assistant query answered|Assistant TTS completed|Assistant TTS failed|Assistant query recording timed out|Dropping ambient audio clip|Uploading audio clip|Audio upload succeeded|ClawSenseService' \
  | tee "$LOG"
```

In another terminal, run each question one by one.

Question 1:

```bash
cd /Users/cedric/Documents/ClawSense
export ADB="$HOME/Library/Android/sdk/platform-tools/adb"
export PKG="ai.openclaw.clawsense.debug"
export REPORT="$(cat /tmp/clawsense-current-report-path 2>/dev/null || ls -t docs/agents/realtime-voice-revalidation-report-*.md | head -n1)"
source /tmp/clawsense-ui-helpers.sh

tap_ask_realtime_assistant
echo '请真人现在说：我现在在看什么？'
read -r -p '说完并等待回答后按 Enter 继续... '
print_clawsense_ui_text | tee -a "$REPORT"
```

Question 2:

```bash
tap_ask_realtime_assistant
echo '请真人现在说：刚才他说了什么？'
read -r -p '说完并等待回答后按 Enter 继续... '
print_clawsense_ui_text | tee -a "$REPORT"
```

Question 3:

```bash
tap_ask_realtime_assistant
echo '请真人现在说：现在有什么需要我注意？'
read -r -p '说完并等待回答后按 Enter 继续... '
print_clawsense_ui_text | tee -a "$REPORT"
```

After the three questions, stop the log watcher with `Ctrl-C`, then append key logs:

```bash
cd /Users/cedric/Documents/ClawSense
export REPORT="$(cat /tmp/clawsense-current-report-path 2>/dev/null || ls -t docs/agents/realtime-voice-revalidation-report-*.md | head -n1)"
export LOG="$(cat /tmp/clawsense-current-log-path 2>/dev/null || ls -t /tmp/clawsense-realtime-voice-*.log | head -n1)"

{
  echo
  echo "## Validation B Logs"
  echo
  cat "$LOG"
  echo
  echo "## Parsed Assistant Answers"
  rg 'Assistant query answered' "$LOG" || true
  echo
  echo "## Parsed TTS Result"
  rg 'Assistant TTS completed|Assistant TTS failed' "$LOG" || true
} | tee -a "$REPORT"
```

Pass criteria:

- Each question should show `Assistant query armed`.
- Each question should show `Assistant query clip captured`.
- Each question should show `Assistant query submitting`.
- Each question should show `Assistant query answered`.
- Best pass: `queryTextLen > 0` and `Assistant TTS completed`.
- STT degraded: `queryTextLen=0` with `sttFailure=...`; record `sttProvider` and `sttFailure`.
- TTS degraded: UI has `最近回答`, but log has `Assistant TTS failed: ...`.

## 6. Validation C: Echo Suppression

Run after at least one TTS success or TTS attempted answer:

```bash
{
  echo
  echo "## Validation C: Echo Suppression"
  echo
  echo "### TTS / Ambient Audio Neighbor Logs"
  rg -n 'Assistant TTS completed|Assistant TTS failed|Dropping ambient audio clip|Uploading audio clip|Audio upload succeeded|Assistant query clip captured' "$LOG" || true
} | tee -a "$REPORT"
```

Pass criteria:

- Query clip is consumed by `Assistant query clip captured`.
- During `SPEAKING_ANSWER`, own TTS should not become a normal ambient upload.
- If there is audio during speaking, expect `Dropping ambient audio clip during assistant phase=SPEAKING_ANSWER`.

## 7. Final Verdict Template

Append the manual verdict:

```bash
cat >> "$REPORT" <<'EOF'

## Final Verdict

- Empty query timeout: pass / failed
- Human query 1: pass / degraded / failed
- Human query 2: pass / degraded / failed
- Human query 3: pass / degraded / failed
- STT:
  - queryTextLen:
  - sttProvider:
  - sttFailure:
- TTS:
  - completed / failed
  - failure message:
- Echo suppression: pass / degraded / blocked

## Notes

- If local config has no model key, mark STT as config-degraded rather than code-failed.
- If queryTextLen > 0 but answer is weak, mark answer-quality separately.
EOF

echo "$REPORT"
```
