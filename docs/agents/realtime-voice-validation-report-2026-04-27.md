# Realtime Voice Validation Report

- Date: 2026-04-27
- Timezone: Asia/Shanghai
- Scope: Direction 1 realtime voice MVP validation on real Android device
- Validator role: Acceptance / realtime voice validation thread
- Runtime: repo-local OpenClaw + local ClawSense host

## Environment

- Android device: `2304FPN6DC`
- APK package: `ai.openclaw.clawsense.debug`
- APK versionName: `0.1.1-ui-textfix1-debug`
- OpenClaw runtime: repo-local
- Gateway status: `running`
- Gateway bind: `lan`
- Gateway port: `18789`

## Files And References Used During Validation

- [AGENTS.md](/Users/cedric/Documents/ClawSense/AGENTS.md)
- [docs/agents/realtime-voice-validation-agent-prompt.md](/Users/cedric/Documents/ClawSense/docs/agents/realtime-voice-validation-agent-prompt.md)
- [docs/dev/开发日志.md](/Users/cedric/Documents/ClawSense/docs/dev/开发日志.md)
- [SensorForegroundService.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt)
- [AssistantTtsController.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/AssistantTtsController.kt)
- [DeviceSessionRepository.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/DeviceSessionRepository.kt)
- [OkHttpClawSenseApi.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/OkHttpClawSenseApi.kt)
- [index.ts](/Users/cedric/Documents/ClawSense/index.ts)
- [openai-client.ts](/Users/cedric/Documents/ClawSense/src/openai-client.ts)

## Precheck Results

### ADB Device

- Result: `pass`
- Evidence:
  - `adb devices -l` returned one `device` state Android device:
    - `c8e666a9 device usb:1-1.1 product:ishtar model:2304FPN6DC device:ishtar`

### APK And Permissions

- Result: `pass`
- Evidence:
  - `versionName=0.1.1-ui-textfix1-debug`
  - `android.permission.CAMERA: granted=true`
  - `android.permission.RECORD_AUDIO: granted=true`
  - `android.permission.POST_NOTIFICATIONS: granted=true`

### Host Assistant Route

- Result: `pass`
- Evidence:
  - `GET http://127.0.0.1:18789/api/clawsense/assistant/query`
  - Returned:

```http
HTTP/1.1 405 Method Not Allowed
allow: POST
{"ok":false,"error":"method_not_allowed","allow":["POST"]}
```

### Recent Context

- Result: `pass`
- Evidence:
  - `ok=true`
  - Returned keys included:
    - `sceneSummary`
    - `recentTranscriptSpans`
    - `peopleHints`
    - `attentionHints`
    - `taskHints`
    - `topEvidence`

Observed sample:

```json
{
  "ok": true,
  "sceneSummary": "Image captured, but the primary multimodal model was unavailable. Device note: active-window.",
  "counts": {
    "windows": 2,
    "events": 8,
    "transcriptSpans": 0
  }
}
```

### Followups

- Result: `pass`
- Evidence:
  - `ok=true`
  - Returned keys included:
    - `evidenceFollowUpTargets`
    - `topPrompts`

Observed sample:

```json
{
  "ok": true,
  "evidenceFollowUpTargets": 3,
  "topPrompts": 3
}
```

## UI Baseline Before Human Query

- Service state visible in UI:
  - `完整模式`
  - `音频 VAD、定格拍照和心跳都在运行`
- Assistant card visible:
  - `实时助手`
  - `就绪中`
  - `问实时助手`
- Page also showed:
  - `最近错误：暂无错误`

## Validation A: Empty Query Timeout Recovery

- Result: `pass`

### User-visible behavior

- User tapped `问实时助手`
- During the timeout window, the ask button disappeared / became unavailable
- After about 12-15 seconds, the button returned
- UI recovered back to `就绪中`
- UI showed the expected failure guidance:

```text
这次没有听到可用问题。请靠近一点，再点一次“问实时助手”。
```

### Key logs

```text
Assistant query armed mode=AUTO timeoutMs=12000
Assistant query recording timed out mode=AUTO
```

### Interpretation

- Trigger path works
- Recording timeout path works
- Service stays alive

## Validation B: Human Single-turn Voice Query

### Prompt Used

User asked twice with the same intent:

```text
我现在在看什么？
```

### Attempt 1

- Result: `degraded`

#### Key logs

```text
Assistant query armed mode=AUTO timeoutMs=12000
Assistant query clip captured mode=AUTO durationMs=4093 bytes=131116
Assistant query submitting mode=AUTO durationMs=4093 bytes=131116
Assistant query answered mode=AUTO queryTextLen=0 answerLen=32 spokenLen=14
Assistant TTS failed: TTS 初始化失败：-1
```

#### UI result

- `最近回答` appeared
- `最近回答` text:

```text
这次我没有听清你的问题。请靠近一点，再用一句短问题重新问我一次。
```

- `最近失败` text:

```text
TTS 初始化失败：-1
```

- Final UI state returned to:
  - `就绪中`

### Attempt 2

- Result: `degraded`

#### Key logs

```text
Assistant query armed mode=AUTO timeoutMs=12000
Assistant query clip captured mode=AUTO durationMs=4229 bytes=135212
Assistant query submitting mode=AUTO durationMs=4229 bytes=135212
Assistant query answered mode=AUTO queryTextLen=0 answerLen=32 spokenLen=14
Assistant TTS failed: TTS 初始化失败：-1
```

#### UI result

- Same as attempt 1
- `最近回答` still showed the fallback "没听清问题" answer
- `最近失败` still showed `TTS 初始化失败：-1`
- Final UI state returned to `就绪中`

## What Definitely Worked

These parts of the realtime voice chain are now validated as working:

1. Assistant trigger path arms successfully
2. Query clip is consumed from the existing VAD microphone path
3. Query clip is submitted to host
4. Host `/api/clawsense/assistant/query` returns an answer payload
5. Android UI can display `最近回答`
6. Assistant state can recover back to `就绪中`

## What Failed Or Degraded

### 1. `assistant-query-stt-empty`

- Severity: high
- Status: `degraded`
- Evidence:
  - Both successful query captures ended with:

```text
Assistant query answered ... queryTextLen=0
```

- Interpretation:
  - This is not a trigger problem
  - This is not a "clip not captured" problem
  - This is not a missing host route problem
  - The query audio reached the assistant path, but no usable query text was produced

### 2. `local-tts init failed (-1)`

- Severity: medium
- Status: `degraded`
- Evidence:

```text
Assistant TTS failed: TTS 初始化失败：-1
```

- Interpretation:
  - Text answer path is alive
  - Local TTS failed independently
  - Service still recovers, so this is a degraded answer experience, not a total chain crash

## Not Yet Validated

### Echo suppression during `SPEAKING_ANSWER`

- Status: `blocked by TTS failure`
- Reason:
  - Since TTS never actually spoke, this round cannot confirm whether assistant playback is properly excluded from ambient ingest

### Meeting / Desk mode

- Status: `not run`
- Reason:
  - Human validation stopped after base AUTO mode reproduced the two main issues

## Root-cause Hints For Main Agent

### Query STT path

Main agent should focus on:

- [index.ts](/Users/cedric/Documents/ClawSense/index.ts)
- `POST /api/clawsense/assistant/query`
- assistant query STT / fallback STT path
- query clip format / mime / file naming / payload assumptions
- why ambient audio uploads continue to succeed while assistant query returns empty `queryText`

### Local TTS path

Main agent should focus on:

- [AssistantTtsController.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/AssistantTtsController.kt)
- MIUI / Xiaomi `TextToSpeech` engine init behavior
- Simplified Chinese locale fallback behavior
- retry / fallback / engine availability handling

## Suggested Fix Priorities

1. Fix `assistant-query-stt-empty`
2. Fix `local-tts init failed (-1)`
3. Re-run human queries:
   - `我现在在看什么？`
   - `刚才他说了什么？`
   - `现在有什么需要我注意？`
4. Re-run `meeting` and `desk` mode checks
5. Re-run echo suppression validation after TTS is working

## Overall Verdict

- Realtime voice MVP: `degraded`

### Why not `failed`

Because the following minimum chain already exists:

- assistant can arm
- assistant can consume next VAD clip
- host can answer
- UI can show answer
- service can recover

### Why not `pass`

Because the two core user-facing pieces are still broken:

- the spoken query is not turned into usable `queryText`
- local TTS cannot initialize and speak

## Minimal Delivery Judgment

Current state is suitable for:

- continued engineering iteration
- host/client chain debugging
- regression testing of trigger / timeout / UI recovery

Current state is not yet suitable for:

- reliable real-world single-turn voice assistant use
- spoken-answer experience
- confidence that the assistant actually understood the human query content
