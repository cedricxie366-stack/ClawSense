# ClawSense

[![license](https://img.shields.io/github/license/cedricxie366-stack/ClawSense)](./LICENSE)
[![release](https://img.shields.io/github/v/tag/cedricxie366-stack/ClawSense?label=release)](https://github.com/cedricxie366-stack/ClawSense/releases)

Turn an old Android phone into an always-on sensory node for OpenClaw.

ClawSense is an OpenClaw plugin plus an Android client. It pairs once, keeps a long-lived `deviceSecret`, and continuously sends:

- VAD-triggered audio clips
- periodic image snapshots
- heartbeat / liveness signals
- memory-ready ingest events for OpenClaw

## Project Status

The project is now at a clear transition point:

- `Phase 1` is already real and usable:
  - Android pairing works
  - foreground sensing works
  - audio upload works
  - image upload works
  - OpenClaw host-side ingest works
  - the repo is prepared for GitHub/npm release
  - the npm package target is `clawsense`, but it is not published yet as of 2026-05-30 (`npm view clawsense` returns 404)
- the active next stage is:
  - multimodal OpenClaw-driven daily sensing and review
  - event indexing
  - lightweight media library
  - Daily Review skill
- an additional compatibility direction is already acknowledged:
  - **align with the official OpenClaw control plane later**
  - **keep the ClawSense ingest data plane**

In other words:

- today, ClawSense already ships its own pairing and ingest path
- next, we improve the multimodal review product
- later, we can add official OpenClaw node/control-plane compatibility without throwing away the current data layer

## Recommended Model Setup

ClawSense is now designed for **OpenClaw instances driven by native multimodal models**.

Recommended examples:

- Kimi K2.5
- Qwen 3.5 / Qwen VL class models
- GLM 5
- Gemini multimodal models

Why this is the recommended path:

- end-of-day review quality depends on image and audio window understanding
- key-window analysis works better when the main OpenClaw model can reason over mixed media
- runtime STT is still supported, but only as a fallback when multimodal understanding is unavailable

Non-multimodal OpenClaw setups are still supported as a degraded path, but they are no longer the primary recommendation.

## Control Plane Direction

ClawSense does **not** currently replace its working ingest path with the official OpenClaw Android Companion protocol.

The intended long-term direction is:

- official OpenClaw control-plane compatibility for device presence, pairing semantics, and on-demand commands
- ClawSense data-plane retention for continuous audio / image ingest, event indexing, media storage, and daily review

That means the future target is a **hybrid architecture**, not a full rewrite of the current MVP transport.

## What Works Today

The following paths have been verified on a real server plus a real Android phone:

- OpenClaw server plugin loading
- QR pairing
- persistent `deviceSecret`
- Android foreground service start / stop
- clear runtime states in the app UI
- audio upload
- image upload
- heartbeat reporting
- server-side ClawSense journal persistence
- raw media persistence in a durable media root
- lightweight host-side media library page
- daily review generation over indexed event windows

## Product Entry Points

ClawSense currently has three user-facing entry points, and each one has a different job:

- `openclaw clawsense devices`
  Use this to confirm which Android node is paired and still alive.
- `openclaw clawsense media today` or `/plugins/clawsense/library`
  Use this to browse the raw perception library by date, device, audio, and image. This is the raw sensing surface, not the final review page.
- `openclaw clawsense review today` or the repo-local Daily Review skill
  Use this when you want the assistant-style end-of-day recap with people, projects, details, follow-up questions, and tomorrow focus.

## Media Library Access Model

ClawSense media browsing follows one hard rule:

- it should reuse the **same host and origin the user already uses for OpenClaw**
- it should **not** depend on any ClawSense-owned public relay domain
- it should **not** assume users will configure a custom domain, reverse proxy, or extra route by hand

So the intended default shape is:

- if a user opens OpenClaw at `http://1.2.3.4:18789/`
  the library should live at `http://1.2.3.4:18789/plugins/clawsense/library`
- if a user opens OpenClaw at `https://example.com/`
  the library should live at `https://example.com/plugins/clawsense/library`

The media library is meant to become a **same-host, same-origin, lightweight page**. Export stays as a secondary capability for offline backup or sharing, not the main browsing path.

## Quick Links

- [当前阶段交付收口清单](./docs/当前阶段交付收口清单.md)
- [当前阶段分批提交计划](./docs/当前阶段分批提交计划.md)
- [当前阶段正式收口总结](./docs/当前阶段正式收口总结.md)
- [小白部署与使用指南](./docs/小白部署与使用指南.md)
- [架构师交接摘要](./docs/架构师交接摘要.md)
- [Android 客户端说明](./android/README.md)
- [多 Agent 协作分工说明](./docs/多Agent协作分工说明.md)
- [第三轮具体任务单](./docs/agents/第三轮具体任务单.md)
- [GitHub 与 npm 发布清单](./docs/GitHub与npm发布清单.md)
- [ClawSense Daily Review Skill](./skills/clawsense-daily-review/SKILL.md)
- npm package target: `clawsense` (publish pending)
- [GitHub Releases](https://github.com/cedricxie366-stack/ClawSense/releases)

## Install

If you already have this repository or a source checkout on the target machine, run:

```bash
bash install.sh
```

If you want the server to download a source archive:

```bash
CLAWSENSE_SOURCE_URL="https://your-host.example/clawsense-plugin.tar.gz" bash install.sh
```

After the npm package is published, the intended package-install path is:

```bash
CLAWSENSE_NPM_SPEC="clawsense@latest" bash install.sh
```

After installation, generate a pairing QR code:

```bash
openclaw clawsense pair
```

If your gateway uses `bind=lan` / `0.0.0.0`, make sure the pairing URL resolves to a real host/IP reachable by phone clients:

```bash
openclaw config set plugins.entries.clawsense.config.publicBaseUrl "\"http://<公网IP或域名>:<gateway-port>\"" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

You can also provide a host through environment variable fallback:

```bash
export CLAWSENSE_PUBLIC_HOST="<公网IP或域名>"
```

Then the main operator-facing commands are:

```bash
openclaw clawsense devices
openclaw clawsense status
openclaw clawsense doctor
openclaw clawsense media today
openclaw clawsense library-url today
openclaw clawsense review today
openclaw clawsense consolidation today
openclaw clawsense evidence today --question "今天发生了什么"
openclaw clawsense evidence today --modality video --question "今天有哪些视频片段和关键帧值得回看"
openclaw clawsense followups today --focus what_happened --question "今天哪些片段值得我继续追问"
openclaw clawsense annotate-suggestions today --question "有哪些人物线索需要我补标注"
openclaw clawsense annotate-apply-suggestions today --question "有哪些人物线索需要我补标注"
openclaw clawsense acceptance 7
openclaw clawsense acceptance-plan 7
```

The intended lightweight media library address is:

```text
http://<your-current-openclaw-host>:<gateway-port>/plugins/clawsense/library
```

The page stays on the same OpenClaw host/origin, but media and index requests require the current OpenClaw gateway token. The token is stored only in the current browser.

If you want a ready-to-open URL plus token status, run:

```bash
openclaw clawsense library-url today
# or (repo-local helper with backward-compatible fallback)
scripts/local-openclaw.sh library-url today
scripts/local-openclaw.sh followups
```

Recommended daily usage path after installation:

1. Pair the old Android phone and start sensing.
2. Open the media library on the same host you already use for OpenClaw to verify the raw audio and image timeline for the day.
3. Run `openclaw clawsense review today` or use [ClawSense Daily Review Skill](./skills/clawsense-daily-review/SKILL.md) in the normal chat page for the assistant-style recap.
4. Run `openclaw clawsense acceptance 7` to see whether the current short-term phase has reached the 5 completion criteria.
   The report now includes `completion.phaseState` (`collecting-data | hardening | ready-to-close`), top-level `blockers`, and per-criterion `targets` (`current vs target`) so you can drive acceptance without guessing.
5. Run `openclaw clawsense acceptance-plan 7` when you need an actionable closure playbook (each criterion's failing targets, next actions, and runnable commands).

Natural language date recall is supported in the normal chat page as well. Typical examples:

- `今天发生了什么？`
- `昨天发生了什么？`
- `前天有哪些只是角色线索，还没有确认身份？`
- `2026-03-31 那天记录到了什么？`

## Provider Configuration Guide

ClawSense is designed to work with different model vendors, but there is one important real-world detail:

- different OpenClaw deployments do not always expose provider metadata in the same schema
- some deployments give ClawSense only a model string, without a usable provider map

Because of that, the **most portable setup today** is:

- configure your main OpenClaw model as usual
- also give ClawSense an explicit **OpenAI-compatible** client via plugin config

That means these plugin fields are currently the most reliable cross-provider contract:

- `plugins.entries.clawsense.config.openaiApiKey`
- `plugins.entries.clawsense.config.openaiBaseUrl`
- `plugins.entries.clawsense.config.visionProvider`
- `plugins.entries.clawsense.config.visionModel`

For capability-oriented rollout (instead of vendor-oriented defaults), these two fields are now available as well:

- `plugins.entries.clawsense.config.retrievalEmbeddingBackend` (`none | text | multimodal`)
- `plugins.entries.clawsense.config.hostModelAudioMode` (`balanced | asr-first`)
- `plugins.entries.clawsense.config.hostModelImageMode` (`multimodal | metadata-only`)
- `plugins.entries.clawsense.config.hostModelVideoMode` (`none | keyframes | direct`)

Important:

- `visionProvider = openai` here means **use the OpenAI SDK / OpenAI-compatible route**
- it does **not** mean you must use OpenAI's own hosted models
- if your provider exposes an OpenAI-compatible endpoint, you can still use it here

Current behavior:

- `retrievalEmbeddingBackend = text` (default): ClawSense writes text embeddings and enables semantic recall in `clawsense_context`.
- `retrievalEmbeddingBackend = none`: skip vector indexing and semantic recall (timeline/person/project retrieval still works).
- `retrievalEmbeddingBackend = multimodal`: this build falls back to text embedding while keeping the config contract for upcoming native multimodal indexing.
- `hostModelAudioMode = balanced` (default): runtime STT first, then multimodal understanding, then STT fallback.
- `hostModelAudioMode = asr-first`: runtime STT first, then STT fallback, and only then multimodal audio understanding.
- `hostModelImageMode = multimodal` (default): image events try multimodal preview and degrade only on failures.
- `hostModelImageMode = metadata-only`: image events skip multimodal calls and store metadata/degraded summaries directly.
- `hostModelVideoMode = none` (default): video ingest is disabled and `/api/clawsense/ingest/video` returns `video_ingest_disabled`.
- `hostModelVideoMode = keyframes`: video ingest is accepted and raw video is preserved; semantic understanding relies on optional `keyframes[]` image evidence and the video event itself stays metadata/degraded.
- `hostModelVideoMode = direct`: video ingest is accepted and ClawSense first tries native multimodal video understanding; if provider/model rejects video, it gracefully degrades to metadata summary.
- `/api/clawsense/ingest/video` supports optional `keyframes[]` (base64 image frames), queued as image evidence to prepare keyframe retrieval and cross-check.
- Each `keyframes[]` item may optionally include `caption`, `ocrHints` / `ocrText`, and `videoOffsetMs` / `videoOffsetSec`; the server encodes them into stable keyframe markers before the image evidence is queued.
- Video keyframe notes may carry structured markers such as `caption=...`, `ocr=...`, and `videoOffsetMs=...`; these are surfaced in `videoEvidenceGroups.keyframeDetails` so the chat layer can cite the exact frame and linked video segment.

Useful capability mode commands:

```bash
# stable default
openclaw config set plugins.entries.clawsense.config.hostModelAudioMode "\"balanced\"" --strict-json
openclaw config set plugins.entries.clawsense.config.hostModelImageMode "\"multimodal\"" --strict-json
openclaw config set plugins.entries.clawsense.config.retrievalEmbeddingBackend "\"text\"" --strict-json

# conservative fallback mode (audio 先走 ASR，图像仅元数据)
openclaw config set plugins.entries.clawsense.config.hostModelAudioMode "\"asr-first\"" --strict-json
openclaw config set plugins.entries.clawsense.config.hostModelImageMode "\"metadata-only\"" --strict-json

openclaw gateway restart --json || openclaw gateway start --json
```

### Copy-Paste Setup: Local Open-Source ASR

For realtime voice queries, ClawSense can use a local offline ASR model before falling back to any cloud STT provider. This is the preferred free-first path for personal and open-source deployments.

The first supported local backend is:

- `sherpa-onnx-sensevoice`
- recommended model: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`

Example host-side setup:

```bash
openclaw config set plugins.entries.clawsense.config.localAsrBackend "\"sherpa-onnx-sensevoice\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrModelDir "\"/absolute/path/to/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrLanguage "\"auto\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrNumThreads "2" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

When enabled, assistant query transcription tries:

1. OpenClaw runtime STT
2. local offline ASR
3. OpenAI-compatible STT fallback
4. primary multimodal audio understanding

This lets the realtime assistant answer spoken questions without requiring an API key, as long as the host has the local model files installed.

### Portability Rules

If you want your deployment to be easier to reason about and easier for others to copy, follow these rules:

- prefer **pure model names**, not `provider/model` combined strings
- keep provider identity and model identity separate when your OpenClaw config supports that
- if your provider exposes an OpenAI-compatible endpoint, feed that endpoint directly into ClawSense plugin config
- do not assume every OpenClaw deployment will expose a standardized runtime `providers` map

Recommended:

```text
model = qwen3-max-2026-01-23
provider = alibaba-cloud
```

Less portable:

```text
model = alibaba-cloud/qwen3-max-2026-01-23
```

### Copy-Paste Setup: OpenAI Official

If you want the simplest default path with OpenAI official endpoints:

```bash
openclaw config set plugins.entries.clawsense.config.openaiApiKey "\"$OPENAI_API_KEY\"" --strict-json
openclaw config set plugins.entries.clawsense.config.openaiBaseUrl "\"https://api.openai.com/v1\"" --strict-json
openclaw config set plugins.entries.clawsense.config.visionProvider "\"openai\"" --strict-json
openclaw config set plugins.entries.clawsense.config.visionModel "\"gpt-4.1-mini\"" --strict-json
openclaw config set plugins.entries.clawsense.config.sttFallbackModel "\"whisper-1\"" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

When this is a good fit:

- your OpenClaw host already uses OpenAI
- you want the easiest supported setup
- you want image fallback and STT fallback on the same vendor

### Copy-Paste Setup: DashScope / Qwen (Beijing)

If your OpenClaw host uses Alibaba Cloud Model Studio through its OpenAI-compatible endpoint:

```bash
openclaw config set plugins.entries.clawsense.config.openaiApiKey "\"$DASHSCOPE_API_KEY\"" --strict-json
openclaw config set plugins.entries.clawsense.config.openaiBaseUrl "\"https://dashscope.aliyuncs.com/compatible-mode/v1\"" --strict-json
openclaw config set plugins.entries.clawsense.config.visionProvider "\"openai\"" --strict-json
openclaw config set plugins.entries.clawsense.config.visionModel "\"qwen3-omni-flash\"" --strict-json
openclaw config set plugins.entries.clawsense.config.sttFallbackModel "\"qwen3-asr-flash\"" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

Recommended pairing for the runtime primary model:

```text
agents.defaults.model.primary = qwen3-max-2026-01-23
```

Notes:

- use the region-correct endpoint for your DashScope key
- for Beijing region, use `https://dashscope.aliyuncs.com/compatible-mode/v1`
- for image and audio fallback, `qwen3-omni-flash` is currently a strong practical choice because it supports multimodal understanding through the OpenAI-compatible route
- for realtime voice query transcription, prefer `qwen3-asr-flash`; `whisper-1` is an OpenAI model name and is usually wrong for DashScope keys

### Copy-Paste Setup: Any Other OpenAI-Compatible Provider

If your provider is not OpenAI official, but it supports the OpenAI SDK format:

```bash
export CLAWSENSE_COMPAT_KEY="replace-me"
export CLAWSENSE_COMPAT_BASE_URL="https://your-provider.example/v1"
export CLAWSENSE_COMPAT_VISION_MODEL="replace-with-a-real-vision-or-omni-model"

openclaw config set plugins.entries.clawsense.config.openaiApiKey "\"$CLAWSENSE_COMPAT_KEY\"" --strict-json
openclaw config set plugins.entries.clawsense.config.openaiBaseUrl "\"$CLAWSENSE_COMPAT_BASE_URL\"" --strict-json
openclaw config set plugins.entries.clawsense.config.visionProvider "\"openai\"" --strict-json
openclaw config set plugins.entries.clawsense.config.visionModel "\"$CLAWSENSE_COMPAT_VISION_MODEL\"" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

Use this pattern when:

- your provider exposes OpenAI-compatible `chat` / `responses` routes
- you do not want to depend on OpenClaw runtime provider auto-discovery
- you want ClawSense to resolve clients predictably across different deployments

### What `visionModel` Should Be

`visionModel` should not just be “any cheap model”.

Pick a model that can actually help with the two ClawSense fallback jobs:

1. image understanding
2. conservative audio understanding when runtime STT is empty

So the best candidates are:

- multimodal vision-language models
- omni models that can accept image or audio input
- OpenAI-compatible models that support `image_url`, `input_image`, or `input_audio`

Less suitable choices:

- text-only chat models
- embedding models
- models that require a custom non-OpenAI API protocol

### Minimal Smoke Check After Config

After changing provider config, do not guess. Verify with one tiny sample:

1. say one clear `5-10s` Chinese audio clip
2. wait for one fresh image capture
3. run:

```bash
openclaw clawsense context last-hour
```

What you want to see:

- new image events with real summaries instead of `visual summary unavailable`
- new audio events with a conservative summary instead of `speech transcription unavailable`
- `analysisStatus = succeeded` more often than degraded

If you are debugging a deployment and need the raw event view, inspect:

```text
~/.openclaw/plugins/clawsense/state.json
```

and look at:

- `analysisProvider`
- `analysisStatus`
- `analysisFailureReason`

### Common Deployment Pitfalls (and Current Behavior)

1. Provider key still left as placeholder (for example `"$api-key"`)

- ClawSense now treats placeholder-looking keys as invalid runtime credentials.
- If a provider entry still has placeholder key text, ClawSense will try explicit OpenAI-compatible credentials (`openaiApiKey` + `openaiBaseUrl`) when safe.
- For non-OpenAI provider IDs, this fallback only applies when `openaiBaseUrl` is explicitly set and the provider exists in runtime config.

2. Temporary upload spikes causing `HTTP 503 {"error":"ingest_queue_full"}`

- ClawSense queue already coalesces repeated image snapshots.
- ClawSense now also coalesces repeated audio retries for the same session/segment (or same capture timestamp), so retry storms are less likely to saturate the queue.
- when the queue is full, API now returns `retryAfterSec` and `Retry-After` to guide client backoff.
- If queue is still full of unique audio jobs, `503` is still expected to preserve data integrity (we avoid dropping unique audio blindly).

3. Heartbeat/upload returning `401 unauthorized`

- the API now returns structured auth reason fields (`reason`, `hint`, `rePairRequired`) instead of a generic unauthorized only.
- Android uploads/heartbeat now send `X-ClawSense-Device-Id`, so server logs and response hints can distinguish:
  - missing bearer token
  - secret mismatch for a known device
  - device not registered on server
- use `openclaw clawsense status` (or `GET /api/clawsense/status`) to quickly check queue depth, active device count, and recent ingest health before blaming model quality.
- use `openclaw clawsense doctor` to get both runtime diagnostics and a 7-day acceptance snapshot (`phaseState`, `progressPct`, blockers + top next actions).

## Current Limits

This is a real, working MVP, but not yet a fully polished public release.

- `install.sh` works well on normal Linux environments, but `2GB` servers may still OOM during OpenClaw installation
- runtime STT is fallback-only; if multimodal reasoning and text transcription are both unavailable, ClawSense degrades to low-fidelity summaries instead of hard failing
- the media library is intentionally lightweight and should be treated as a raw perception library, not a fixed full-review dashboard
- the current implementation still needs to be fully decoupled from the OpenClaw Control UI shell in some deployments; the product target is a same-host independent page, not a chat/control sub-experience
- there is still no polished device management UI
- low-memory deployment still needs a maintainer-style prebuilt path in some cases
- video acceptance is now tracked as `video-evidence`; when `hostModelVideoMode=none`, this criterion is treated as intentionally disabled and will not block phase closure
- voice-triggered video recording remains out of scope for this phase
- ClawSense does not make automatic micro-expression, emotion, or inner-state conclusions from faces or images

## Event Indexing Model

ClawSense no longer treats a day as one giant raw media blob. The flow is:

1. ingest raw audio / image artifacts
2. persist them under a readable date and device directory
3. normalize them into `CaptureEvent`
4. group them into event windows
5. let OpenClaw's multimodal model analyze only the key windows
6. generate `DailyReview`

This keeps latency, token cost, and context growth under control.

## Host-Side Media Layout

Raw media is persisted under:

```text
~/.openclaw/plugins/clawsense/media/YYYY/MM/DD/<deviceAlias>/
```

Naming rules:

- audio: `HHmmss-audio-<eventId>.wav`
- image: `HHmmss-image-<eventId>.jpg`

Default retention:

- raw artifacts: `7 days`
- indexed events and daily reviews: retained beyond raw cleanup
- raw media is **not** deleted at midnight; cleanup is based on each artifact's own retention deadline

Default storage pressure guard:

- ClawSense also keeps a raw-media soft cap of `2 GiB` by default
- if raw artifacts grow past that cap, the host will delete the **oldest audio/image originals first**
- event indexes and daily reviews stay available even after the raw files are removed
- you can change the cap with plugin config `maxArtifactBytes`
- set `maxArtifactBytes` to `0` if you explicitly want to disable the size cap

If you do **not** want ClawSense to auto-delete raw audio/image originals:

- set `artifactRetentionDays` to `0` to disable time-based raw cleanup
- set `maxArtifactBytes` to `0` to disable size-cap pruning

With both values set to `0`, raw media originals will be retained indefinitely unless you delete them yourself.

This means `7 days` is the **upper bound**, not an unconditional guarantee. On small cloud hosts, old originals may be pruned earlier to avoid filling the disk.

## Daily Review Usage

The raw media library and Daily Review are different tools:

- `/plugins/clawsense/library` is for checking whether ClawSense actually captured the day correctly
- `review` is for getting the assistant-style recap

Use Daily Review from the host CLI:

```bash
openclaw clawsense review today
openclaw clawsense review 2026-03-10
openclaw clawsense consolidation today
openclaw clawsense consolidation 2026-03-10
```

If you want a **custom evidence window** (not just `today` / `last-hour`), use the evidence API with explicit timestamps:

```text
GET /api/clawsense/evidence?startAt=1770000000000&endAt=1770003600000
```

You can also pass an optional `question` query for semantic relevance prioritization:

```text
GET /api/clawsense/evidence?startAt=1770000000000&endAt=1770003600000&question=Amy%20%E6%8A%A5%E4%BB%B7%E8%AE%A8%E8%AE%BA
```

Rules:

- `startAt` / `endAt` are Unix timestamps in milliseconds
- `endAt` must be greater than `startAt`
- this returns a `custom-range` evidence payload (`text + details + evidenceBundle`) aligned with chat tool behavior
- you can also pass `lookbackDays` (2-30) to build a rolling custom-range automatically

You can do the same from CLI:

```bash
openclaw clawsense evidence today --question "今天发生了什么"
openclaw clawsense evidence --startAt 1770000000000 --endAt 1770003600000 --focus what_happened
openclaw clawsense evidence --lookbackDays 7 --question "最近7天最值得注意的任务和人物是谁"
```

`openclaw clawsense context ...` remains available for lightweight prompt context; `openclaw clawsense evidence ...` is the structured export path for downstream retrieval/consolidation pipelines.

For day-level structured memory output (tasks/people/projects/learning-points), use:

```text
GET /api/clawsense/consolidation?date=2026-03-10
```

For runtime diagnostics (queue depth / device activity / ingest health), use:

```text
GET /api/clawsense/status
```

For structured follow-up actions (audio/video/history prompts ready for chat buttons), use:

```text
GET /api/clawsense/followups?scope=today&focus=what_happened
```

Evidence bundle contract additions in this phase:

- `schemaVersion`
- `timeRange` (`scope`, `date`, `startAt`, `endAt`, `label`)
- `topEvidence`
- `transcriptSpans`
- `artifactRefs`
- `videoEvidenceGroups` (按 `videoRequestId` 聚合，并提供 `videoDetails` / `keyframeDetails` / `transcriptSpans` / `semanticSignals`；关键帧明细现包含 `caption`、`ocrHints`、`videoOffsetMs` / `videoOffsetLabel`、`linkedVideoEventId`、`linkedVideoTime` 等稳定关联字段)
- `fragments` / `topEvidence` 视频片段会携带 `artifactId` / `videoRequestId` / `keyframeIndex`（若可用）
- `videoCoverage`（视频证据覆盖统计：视频组数量、含原始视频组、含关键帧组、含 OCR 线索组、关键帧关联片段数、待补细节组）
- `responseHints.audioFollowUpTargets`（结构化音频追问目标，含 `windowId/status/eventId/artifactUrl/transcriptExcerpt`）
- `responseHints.videoFollowUpTargets`（结构化视频追问目标，含 `eventId` / `artifactId` / `keyframeIndex` / `artifactUrl`）
- `responseHints.evidenceFollowUpTargets`（统一音频/视频/历史记忆追问入口，便于聊天页直接渲染动作卡）
- `annotationSuggestions`（结构化人物/说话人标注建议，含可执行 command template）

What the command does:

1. collects that day's indexed `CaptureEvent` windows
2. prefers the current OpenClaw multimodal model for key-window analysis
3. falls back to heuristic summarization when multimodal analysis is unavailable
4. caches the generated `DailyReview` and refreshes it when newer events arrive

What you should expect in the output:

- `Today at a glance`
- `时间线回顾`
- `关键人物`
- `关键项目 / 主题`
- `值得注意的细节`
- `今天遗漏但值得追问的点`
- `明天建议关注的事情`

Current quality note:

- the command is already usable today
- the final quality still depends on audio transcripts, image summaries, person annotations, and the quality of the OpenClaw multimodal model
- if transcripts or image summaries are weak, Daily Review will still run, but it will sound more like a structured fallback than a polished private assistant

## Chat Page Skill Entry

Normal chat should not enter ClawSense by scanning arbitrary files.

The intended path is:

1. call the explicit `ClawSense` skill / tool
2. read `review` first
3. read `events` only when review is not enough
4. read controlled `artifacts` only when a representative original is really needed

Natural user prompts we should support in the normal chat page:

- “总结过去一个小时我需要注意的地方”
- “回顾今天发生了什么”
- “把今天最值得记住的 3 件事告诉我”

This keeps the chat entry aligned with the same controlled data plane as the CLI and media library, instead of falling back to raw filesystem browsing.

## Minimal Annotation Loop

The smallest working annotation loop today is:

1. open `/plugins/clawsense/library` to confirm the day was actually captured
2. run `openclaw clawsense review today`
3. run `openclaw clawsense annotate-suggestions today` to get structured people/speaker suggestions
4. optionally run `openclaw clawsense annotate-apply-suggestions today` (dry-run by default) and add `--yes` only when you agree with selected high-confidence people suggestions
   - safer batch mode: `openclaw clawsense annotate-apply-suggestions today --require-relationship --min-confidence high`
   - single-suggestion apply: `openclaw clawsense annotate-apply-suggestions today --id person:person_amy --yes`
5. answer the follow-up questions for people and topics that are still unclear
6. write back person/speaker identity when you know it

The current write-back paths are:

```bash
openclaw clawsense annotate <personRef> <displayName> [notes...] --relationship <关系> --nextWatchFor <下次关注>
openclaw clawsense annotate-speaker <speakerRef> <displayName> --relationship <关系> --windowId <窗口ID>
```

Or use the existing HTTP entry:

```text
POST /api/clawsense/annotations
```

Recommended fields to fill when you know them:

- `displayName`
- `relationship`
- `notes`
- `nextWatchFor`

Current boundary:

- person annotation already has a CLI and API write-back path
- project/topic clarification is currently a review follow-up path, not a standalone persistent command
- this is intentional for now; the goal is to improve the assistant loop without introducing a new schema or a heavy UI

## Android Runtime States

The Android client now exposes explicit runtime states instead of vague button feedback:

- `未配对`
- `启动中`
- `运行中 · 完整模式`
- `运行中 · 仅音频`
- `运行中 · 仅图片`
- `已停止`
- `异常`

That means users can tell whether the service actually started, whether it is degraded, and whether it has stopped cleanly.

## Android Capture Cadence

Current Android defaults:

- baseline snapshots: every `60 seconds`
- active conversation window snapshots: every `10 seconds`
- active window duration after audio activity: `120 seconds`

This keeps the baseline lightweight while still increasing visual coverage around meaningful conversations.

## Repository Layout

- `src/`
  OpenClaw plugin logic, pairing, ingest routes, event indexing, media library, daily review
- `android/`
  Android client, foreground service, CameraX, audio capture, QR pairing
- `skills/`
  repo-local ClawSense daily review skill prompt
- `docs/`
  deployment notes, release checklist, beginner guide
- `install.sh`
  install / enable / restart helper for OpenClaw environments

## Local Development

```bash
npm install
npm run check
npm test
```

## Development Traceability

To keep iteration history searchable and handoff-friendly, append a development log entry whenever you finish a meaningful node:

```bash
bash ./scripts/dev-log.sh "标题" "本次改动摘要" "验证命令与结果" "下一步"
```

Log file:

- [docs/dev/开发日志.md](./docs/dev/开发日志.md)

## Status

Validated baseline:

- OpenClaw `2026.3.2`
- Android 13
- real-device pairing and upload loop

If you are touching this project for the first time, start with:

- [小白部署与使用指南](./docs/小白部署与使用指南.md)
