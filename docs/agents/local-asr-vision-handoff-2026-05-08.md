# Local ASR Validation And Vision Direction Handoff - 2026-05-08

## Role Context

This document is from the validation agent.

The goal of this validation round was not to redesign the whole intelligence stack. It was to verify why the realtime assistant kept replying "我没有听清你的问题", prove whether local open-source ASR can solve that failure mode, and hand the remaining product direction back to the main agent.

## High-Level Result

Local open-source ASR is now validated as a good default direction for realtime voice query transcription.

The realtime assistant no longer fails at the "did not hear the question" layer. After local ASR was enabled, the phone response advanced to the next bottleneck:

```text
场景上看，Image captured, but the primary multimodal model was unavailable. Device note: active-window
```

That means:

- voice capture works
- local ASR works
- assistant route works
- TTS works
- recent context lookup works
- image upload works
- image understanding is still degraded because the primary multimodal model is unavailable

## What Was Implemented For Validation

Added host-side local ASR fallback using `sherpa-onnx-node` with SenseVoiceSmall INT8.

Changed assistant query transcription order to:

```text
OpenClaw runtime STT
-> local offline ASR
-> OpenAI-compatible STT fallback
-> primary multimodal audio understanding
```

Changed files:

- `/Users/cedric/Documents/ClawSense/src/local-asr.ts`
- `/Users/cedric/Documents/ClawSense/src/config.ts`
- `/Users/cedric/Documents/ClawSense/index.ts`
- `/Users/cedric/Documents/ClawSense/openclaw.plugin.json`
- `/Users/cedric/Documents/ClawSense/package.json`
- `/Users/cedric/Documents/ClawSense/package-lock.json`
- `/Users/cedric/Documents/ClawSense/README.md`

Local model path used for validation:

```text
/Users/cedric/Documents/ClawSense/.local/openclaw/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
```

Repo-local runtime config now includes:

```json
{
  "localAsrBackend": "sherpa-onnx-sensevoice",
  "localAsrLanguage": "auto",
  "localAsrNumThreads": 2
}
```

## Validation Evidence

Build and tests:

```text
npm run build: pass
npm test: 151 tests passed
```

Official SenseVoice test wav:

```json
{
  "transcript": "两只小企鹅都有嘢食",
  "analysisProvider": "local-asr:sherpa-onnx-sensevoice:auto"
}
```

Real ClawSense phone-uploaded wav:

```json
{
  "transcript": "那我再改改",
  "analysisProvider": "local-asr:sherpa-onnx-sensevoice:auto"
}
```

Direct `/api/clawsense/assistant/query` smoke test:

```json
{
  "ok": true,
  "queryText": "两只小企鹅都有嘢食",
  "stt": {
    "provider": "runtime-stt|local-asr:sherpa-onnx-sensevoice:auto",
    "failureReason": "runtime_stt_empty",
    "queryDurationMs": 2500
  }
}
```

Phone-side realtime assistant after local ASR:

```text
场景上看，Image captured, but the primary multimodal model was unavailable. Device note: active-window
```

Interpretation:

- This is no longer an ASR failure.
- The assistant heard enough to answer from recent context.
- The remaining poor answer comes from degraded image summaries.

## Product Direction Recommendation

Keep local open-source ASR.

Do not make local open-source vision the default product path right now.

Reasoning:

- ASR is small enough and cheap enough to run locally as a general default.
- Vision understanding is much heavier and would raise hardware requirements for normal users.
- ClawSense users already need an OpenClaw host model. The most universal design is to reuse the same OpenClaw driving multimodal model for image understanding.
- This keeps ClawSense vendor-neutral: if a user drives OpenClaw with Kimi, Qwen VL, GLM, Gemini, or another multimodal model, ClawSense should ask that runtime/model to understand recent images.

Recommended architecture:

```text
Phone sensors
-> ClawSense ingest
-> local ASR for realtime voice query text
-> OpenClaw primary multimodal model for image/audio/video understanding
-> ClawSense memory/review/realtime answer
```

## Remaining Problem

Image events are still being summarized as:

```text
Image captured, but the primary multimodal model was unavailable.
```

This blocks useful answers to questions like:

```text
我现在在看什么？
```

because the realtime assistant only sees degraded recent context instead of semantic image descriptions.

## Main Agent Prompt

```md
You are the main development agent for ClawSense.

Please continue from this validation result:

1. Local open-source ASR has been implemented and validated using `sherpa-onnx-node + SenseVoiceSmall INT8`.
2. Realtime assistant no longer fails with the fixed "我没有听清你的问题" answer.
3. Phone-side validation now reaches the next bottleneck:

   `Image captured, but the primary multimodal model was unavailable. Device note: active-window`

Your task is to solve the image-understanding layer in a product-general way.

Do not make local open-source vision the default path. It is too heavy for the broad user base.

Preferred direction:

- Reuse the OpenClaw host's driving multimodal model for image understanding.
- Treat ClawSense image understanding as a capability routed through OpenClaw's configured primary/multimodal provider whenever possible.
- Keep explicit OpenAI-compatible config as a fallback path, not the only practical path.
- Preserve local ASR as the free default for realtime query transcription.

Please inspect:

- `/Users/cedric/Documents/ClawSense/src/openai-client.ts`
- `/Users/cedric/Documents/ClawSense/src/memory-store.ts`
- `/Users/cedric/Documents/ClawSense/src/review-engine.ts`
- `/Users/cedric/Documents/ClawSense/index.ts`
- `/Users/cedric/Documents/ClawSense/src/openclaw-types.ts`
- `/Users/cedric/Documents/ClawSense/.local/openclaw/state/openclaw.json`

Required outcome:

1. Image ingest should stop degrading to "primary multimodal model unavailable" when the OpenClaw runtime has a usable multimodal primary model.
2. Realtime assistant question `我现在在看什么？` should answer from actual recent image content, not metadata fallback text.
3. Keep local ASR working and do not regress:
   - direct assistant query route should still show `local-asr:sherpa-onnx-sensevoice:auto` when runtime STT is empty.
4. Run build/tests and a real-device validation if possible.

Important guardrails:

- This is a dirty active worktree. Do not revert unrelated changes.
- Keep developer-only guidance out of root `skills/`.
- Keep runtime media/device state under `.local/openclaw/state/plugins/clawsense` intact.
- Do not require paid cloud STT for voice query transcription.
```

## Suggested Acceptance Criteria For Main Agent

After main-agent work, validate:

1. `npm run build` passes.
2. `npm test` passes.
3. `scripts/local-openclaw.sh media-today` shows image and audio events.
4. A new image event receives a semantic summary instead of `primary multimodal model unavailable`.
5. Phone realtime assistant question `我现在在看什么？` produces a content-aware answer.
6. Phone TTS still speaks the answer and returns to `就绪中`.

