# ClawSense

2026-11-03：当前工作区已整理为 **[v0.2.0-preview.12 预览快照](https://github.com/cedricxie366-stack/ClawSense/releases/tag/v0.2.0-preview.12)**，按用户要求包含未完成验收的功能。Host 为 `0.2.0-preview.12`，Android 为 `0.3.12-upstream-device-preview-live-preview`。这是保存现状、供后续改进的预览发布，不代表 P1／P2 整体验收通过。火山等强云端 Live 方案仍处于研究阶段，尚未接入；公开招募未启动。[安装与已知问题](docs/releases/v0.2.0-preview.12.md)。以下日期记录保留各自验证范围。

## P1／P2 集成预览与内测候选

2026-10-29真机续验：Android0.3.12已安装OPPO并配对，新SDK连接与静音文字问答成立。已补会话亮屏；自动接收连接存在系统麦克风访问例外，后续自动准备只走HTTP。最后集中真人检查仍待完成，P1未签核。见[续验记录](docs/validation/p1-upstream-device-2026-10-29.md)。

Host `0.2.0-preview.11`／Android `0.3.11-upstream-live-preview`（versionCode15）已形成可选上游候选。Pipecat接管轮次与媒体，ClawSense保留来源、权限和记忆；独立HF对照、11轮静音模型输出、实际WebRTC收发与停止恢复、三组背景声和图像／记忆／撤权检查取得限定通过。558项项目检查及56项Android JVM通过。当前未检测到已授权手机，新APK尚未安装；最终真人听感、回声与实物集中留到最后，P1未整体签核。见[本轮验收记录](docs/validation/p1-upstream-2026-10-29.md)和[运行约定](docs/contracts/live-upstream-v1.md)。

10月23日候选为Host `0.2.0-preview.10`、Android `0.3.10-live-conversation-preview`（versionCode14）已安装OPPO。正常12轮对话使用实际模型和手机播放器静音检查，75.68秒音频全部播完；分句、朗读／翻译、最新安排及背景推理准备已补修。546项项目检查、56项JVM、6项Python、跨Agent和校准通过。最新6秒完整句首写940ms；冷准备6.7秒；10次生成口令停止均不复播，样本P95为481ms。自然听感仍待一次集中短测，严格300ms及响应长尾仍开放，P1未整体签核。见[本轮记录](docs/validation/p1-normal-dialogue-2026-10-23.md)。

已接入 Live 当前镜头、语音／按钮停止、带来源的近期会话、DSH 与 Codex 实际工作及手机成果复核。手机数字分享、联系人关联、OCR／裁剪／遮挡、共同背景缓存和桌面主动导入使用同一记忆与权限体系。基础模型在自有电脑运行；不是纯手机推理或已验收的全双工产品。

10月19日本地候选版为 `0.2.0-preview.3`，独立 Android **ClawSense Live** 为 `0.3.3-live-latency-preview`（versionCode7）。本批处理响应长尾、模型驻留与释放、中间转写／整句复核、较早用户陈述、回声、服务结束竞争及新画面失败后的旧答复。自动结果、视觉等待和实体设备待验范围见[10月19日自验](docs/validation/p1-autonomous-2026-10-19.md)。旧 `0.2.0-preview.2` 综合包及日期证据保持原哈希；0.3.3尚未安装到本人的OPPO。原 OpenClaw 与 Android 采集入口保留。公共发布和招募按用户安排暂缓，其它宿主的安装配置不等于实际客户端验收。

10月16日真机续验另交付 Android `0.3.1-live-start-preview` 启动修复：连接错误显示在按钮附近、启动等待有时限，实际开启／结束和本机验收限时通过。详见[真机续验记录](docs/validation/p1-p2-human-2026-10-16.md)；旧综合包的APK和哈希保持不变。公共发布与招募已由用户明确暂缓，当前集中验证现场体验。

同日对话质量修复将新准备的本机文本模型与视觉模型分开：文本默认Qwen3-4B-Instruct-2507，视觉保留Qwen3.5-2B；已有配置需明确升级，不自动迁移。翻译／一般解释减少无关私密历史输入，长答后的追问窗口按播报结束续算；未配置联网工具时不编造实时天气。本人已确认本次开镜头的一般问答／追问“实际答案不错，语速正常，语音自然”，见[专项记录](docs/validation/live-dialogue-quality-2026-10-16.md)。十轮真人、插话、视觉故事和设备组合仍待验；后续0.3.2另补调试验收限时，见[最新回执](docs/validation/live-human-confirm-2026-10-16.md)。

- [Live 使用契约](docs/contracts/live-runtime-v1.md)
- [现行总体计划](docs/产品演进路线与执行计划.md)
- [专业场景内测手册与支持范围](docs/pilot/README.md)

主动导入桌面文件：`clawsense import --file ./selected.md --project live`；工作台“导入数字资料”可预览文字／截图，浏览器书签只带入当时选择的片段，确认后保存。来源文本不自动变成业务约定或执行指令。


[![license](https://img.shields.io/github/license/cedricxie366-stack/ClawSense)](./LICENSE)
[![release](https://img.shields.io/github/v/tag/cedricxie366-stack/ClawSense?label=release)](https://github.com/cedricxie366-stack/ClawSense/releases)

ClawSense is building a user-controlled assistant that can hear and see the physical world, remember it with evidence and corrections, and participate through natural Live conversation. It starts with experienced AI users and professional roles, connecting their existing agents to phones and other sensing devices, then evolves toward phone/watch clients and packaged services for everyday users.

**Start with the [product vision and founder’s complete statement](./VISION.md), then the [current evolution and delivery plan](./docs/产品演进路线与执行计划.md).** Natural Live interaction, private memory, selective sharing, and eventual phone-only operation are core goals. A desktop computer is an optional future enhancement; the current developer preview still uses a companion service.

The current Android preview captures consented audio, images and short video, supports bounded spoken questions and TTS, and keeps evidence, corrections and work results available across agents. Broader Live quality, phone-local end-to-end inference, and watch clients remain development targets. OpenClaw remains supported as the original host integration. [Digital context design](./docs/手机与桌面数字上下文规划.md) and [nanoMuse reuse assessment](./docs/research/nanomuse-reuse-2026-10-14.md) supply implementation context.

The current plan explicitly retains mobile sharing/contact/OCR/inbox and reusable memory in P2, desktop inputs, historical Q&A and Daily Review, per-host installation and publishing, selective screen/notification sources, and later phone authority and watch integration. Live is the immediate product track; each retained capability has a delivery batch, dependency and acceptance scope in the [overall plan](./docs/产品演进路线与执行计划.md).

Experimental Live is now integrated from `codex/live-companion` into the shared context core. Android has a separate **ClawSense Live** preview with continuous microphone transport, streaming replies, interruption and DSH result viewing. The default ASR, language model and voice model run on the user's Mac; this is owned-device processing, not phone-local inference or full-duplex acceptance. See the [Live runtime contract](docs/contracts/live-runtime-v1.md) and [integration validation](docs/validation/live-mainline-integration-2026-10-14.md). The original Android app and OpenClaw entry remain available.

## Cross-agent developer preview

The October 14 G2 implementation adds common workspace/person identities, analysis history, correction authority, dependency snapshots, independent result review/replacement, project/source/operation grants, processing-recipient checks, managed deletion and offline migration/recovery. Default reuse selects accepted, current, authorized results. Legacy physical-library credentials retain their existing scope; selective office access requires a new scoped connection. Android validates new answer snapshots and drops tombstoned queued captures. See [implementation and usage](./docs/G2统一上下文实现与使用.md) and [G2 validation](./docs/validation/g2-unified-2026-10-14.md). Phone-local inference, automatic host execution, external-copy erasure and public distribution remain separate work.

The standalone companion now runs without an OpenClaw installation. It provides authenticated MCP over stdio and Streamable HTTP, encounter revisions, explicit corrections, work handoffs and saved results. A local browser console supports pairing, evidence inspection, corrections, downloads and preparation for the next encounter.

Installation bundles can be generated for Pi, Codex, Claude Code, OpenCode, DSH, WorkBuddy, TRAE, Doubao Work, QwenWork and OpenClaw's companion-client mode. The CLI can merge local MCP settings for Pi, Codex, Claude Code and OpenCode. DSH receives a Cordis patch for its existing model environment. OpenClaw receives a native-plugin config fragment for the same companion library, using a revocable `openclaw-client` identity and no second capture service. **Generated configurations and protocol tests do not mean every native host or marketplace has been accepted.** WorkBuddy, TRAE and QwenWork retain native import steps; Doubao Work's HTTP template needs a reachable HTTPS deployment and manual connection verification. Public publishing remains separate.

On October 13, the four-tab Android UI was integrated and a real phone camera image was read by an independent DSH client using the configured GLM gateway. The cup's appearance and large visible text matched the original image. This validates one image case; phone-side automatic visual Q&A and broader G0 quality checks remain open. See the [image acceptance record](docs/validation/g0-cup-vision-2026-10-13.md).

On October 14, the early G0/G1 functional baseline passed for the tested Android device, scenarios and native Codex/DSH hosts. Phone tests confirmed automatic cup-image Q&A, complete reading, cancellation, two-fact speech under tapping noise, no unarmed reply and bounded playback isolation. Native Codex → DSH completed correction, handoff, result storage and reuse by fresh sessions after a service restart. The fourth draft was explicitly selected after three drafts failed semantic checks; older completed drafts are retained and are not automatically superseded. Storage completion does not prove approval, sending or delivery. This is a limited baseline, not acceptance of every host, noise condition or an uninterrupted recorder. Natural voice quality, unified physical/digital context, automatic execution and public release remain open. See the [final baseline record](docs/validation/g0-g1-closeout-2026-10-14.md) and [DSH workflow record](docs/validation/g1-dsh-2026-10-14.md).

Live acceptance has started: Codex CLI 0.154.0 read an original test image and real Android calibration transcript, saved corrections and a draft, and recovered them after a companion restart. That run could not consume native audio directly. Claude Code's October 10 model request returned 401; the October 12 isolated client reported no login. Real phone video with two linked still images and offline recovery across a phone process restart passed limited tests. On October 12 the user confirmed the corrected Friday answer, follow-up, short full-text playback and stop-speaking, with understandable but mechanical voice. Long-text truncation and TTS queue cancellation were fixed; the updated APK passed actual system TTS and UI stop-capture checks without clearing user data. Visual semantics and wider background-speech quality remain open. See the [October 10 record](./docs/validation/g0-g1-live-2026-10-10.md) and [October 12 continuation](./docs/validation/g0-live-2026-10-12.md).

On October 13, actual Codex and OpenClaw clients completed a bounded handoff and saved-result workflow against the same companion. Both recovered the selected OpenClaw draft in fresh sessions after a service restart. Deadline and recipient errors in earlier drafts were caught and retained in the record; saving a result is not content approval. This does not establish all-host acceptance, automatic agent execution, continuous conversation or publication. See the [cross-host acceptance record](./docs/validation/g1-native-2026-10-13.md).

From this source checkout (Node 22.12+):

```bash
npm install
npm run build
node dist/src/cli.js start --lan --local-asr
node dist/src/cli.js open
node dist/src/cli.js connect codex --apply
```

The browser opens locally; use it to obtain a temporary phone setup code. Android capture still starts explicitly in the phone app. `--lan` selects a private LAN address; use `--public-url` when multiple network interfaces require a different address. Keep the host reachable during capture. Omitting `--lan` limits the service to this computer.

Default companion state is `~/.clawsense`, separate from OpenClaw. Each connected agent receives a revocable credential for this owner's library. `--local-asr` prepares the free SenseVoice int8 speech model (about 240 MB on first use), verifies pinned file hashes and native loading, then reuses it. It needs no Python setup or paid API key. The generated companion preset disables inherited cloud credentials, leaves image/video interpretation to the connected agent, and keeps raw media locally. Connecting a cloud agent still grants it access to the evidence it requests; this is not a claim that the whole chain stays local. Custom processing configurations remain available through `--config`.

See [cross-agent usage](./docs/跨Agent插件使用指南.md), [current development plan](./docs/产品演进路线与执行计划.md) and [G2 validation](./docs/validation/g2-unified-2026-10-14.md). Complete sensing quality, all target hosts, graphical installation and public directory publication remain pending.

The research question behind the project is simple:

> Can an agent understand what is happening in the user's immediate physical world, answer in real time, cite the evidence it used, reject ambient false triggers, and accept human corrections?

Most agent benchmarks still happen in text, browsers, desktop apps, or isolated video clips. ClawSense explores a different setting: the room around the user. It is meant for questions like "What just happened?", "What am I looking at now?", "What did we discuss in the last four hours?", and "What evidence supports your answer?"

## What This Repository Contains

This repository is both a runnable prototype and the start of a research harness.

- **Android sensory node**: QR/setup-code pairing, persistent `deviceSecret`, foreground sensing, VAD-triggered audio upload, periodic image upload, manual short-video upload, explicit voice query, local TTS, read-full and stop-speaking controls, TTS echo-drain logic, and heartbeat.
- **Host-side evidence layer**: OpenClaw plugin loading, pairing and ingest endpoints, fast artifact persistence, asynchronous analysis, media/event indexing, same-origin media library, custom-range evidence API, evidence bundles, daily review, follow-up targets, and person/speaker annotation suggestions.
- **Real-time assistant layer**: `/api/clawsense/assistant/query`, evidence-first answer construction, model answer plus deterministic fallback, time-range routing for last seconds/minutes/hours/day, previous-turn follow-up support, and assistant diagnostics.
- **Safety and validation**: no-arm ambient validation, TTS echo-drain validation, Android live validation scripts, staged release gates, auto-video trigger guardrails, and backpressure-aware capture throttling.

## ClawSense-Interact

The research track is called **ClawSense-Interact**. It evaluates real-time multimodal agents grounded in a user's physical world, with four pillars:

1. **Physical-world grounding**: can the agent answer questions about the user's actual surroundings rather than generic memory?
2. **Real-time multimodal interaction**: can audio, images, and short video support an ongoing conversation with interruptions, follow-ups, and spoken responses?
3. **Ambient safety and intent boundaries**: can the system distinguish explicit user queries from background speech, nearby media, meetings, and its own TTS output?
4. **Human steering and long-session memory**: can users correct person labels, tasks, projects, and preferences without creating stale or opaque memory?

Retail and frontline service are the first high-density validation domain. A short sales consultation combines noisy speech, multiple participants, visual product context, ambiguous customer needs, staff response quality, follow-up opportunities, and strict privacy boundaries. That makes it a useful test case for physical-world agents before moving into higher-stakes deployment.

## Start Here For Reviewers

If you are reviewing the project from the GitHub link, these files are the shortest path through the work:

- [Thinking Machines grant packet](./docs/grants/thinking-machines-interactivity-2026/README.md): positioning, proposal, budget, demo narrative, and prototype evidence.
- [Project proposal draft](./docs/grants/thinking-machines-interactivity-2026/proposal.md): research plan for ClawSense-Interact.
- [Scripted demo narrative](./docs/grants/thinking-machines-interactivity-2026/scripted-demo-narrative.md): a consented retail consultation scenario that can be run without exposing real customer data.
- [Prototype evidence summary](./docs/grants/thinking-machines-interactivity-2026/prototype-evidence.md): current implemented capabilities and validation commands.
- [Validation guide](./docs/validation/README.md): non-device product gate, public meeting replay checks, and what still requires a real Android device.
- [Android client guide](./android/README.md): phone-side pairing, sensing, and service behavior.
- [Daily Review skill](./skills/clawsense-daily-review/SKILL.md): user-facing review workflow over captured evidence.

The most relevant code paths are:

- [src/realtime-assistant.ts](./src/realtime-assistant.ts): evidence-first answer construction and time-range query handling.
- [src/http.ts](./src/http.ts): pairing, ingest, media, evidence, and assistant endpoints.
- [src/review-engine.ts](./src/review-engine.ts): daily review generation over indexed evidence windows.
- [src/auto-video-trigger.ts](./src/auto-video-trigger.ts): guarded short-video trigger logic.
- [android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt](./android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt): Android foreground sensing, heartbeat, TTS, echo drain, and capture directives.

## Current Status

ClawSense is a real working MVP, not a mockup. The following paths have been implemented and validated on host-side fixtures and, for core flows, a real Android device:

- OpenClaw server plugin loading
- QR/setup-code pairing
- persistent device credentials
- Android foreground service start/stop
- audio, image, heartbeat, and short-video ingest
- durable raw media persistence
- media/event indexing
- lightweight host-side media library
- evidence bundle export
- daily review generation over indexed event windows
- realtime voice query with local TTS response controls
- ambient no-arm and TTS echo-drain validation
- staged release and Android live validation scripts

The npm package target is `clawsense`; source checkout is still the primary path while public package publishing is pending.

## Validation

Common checks:

```bash
npm run check
npm test
npm run check:non-device-product-gate
npm run report:non-device-product-gate
npm run check:release
npm run check:phase9
```

`check:non-device-product-gate` is the preferred host-side gate when no physical Android device is available. It validates evidence routing, historical recall, cached ASR/diarization replay, speaker annotation, active raw-audio diagnostics, and auto-video fixtures. `report:non-device-product-gate` reads the latest gate report without rerunning the long checks; if `freshness.isStale=true`, rerun the full gate before sign-off.

Android build:

```bash
cd android
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew assembleDebug
```

Repo-local OpenClaw workflow:

```bash
scripts/local-openclaw.sh pair
scripts/local-openclaw.sh devices
scripts/local-openclaw.sh media-today
scripts/local-openclaw.sh review-today
scripts/local-openclaw.sh evidence-video
```

## Privacy And Safety Stance

ClawSense is designed around consent, local-first data handling, inspectable evidence, trigger auditing, and explicit user control.

- Public demos and benchmarks should use scripted, consented scenes.
- Private raw audio, images, videos, gateway tokens, API keys, and local `.local/openclaw` state should not be published.
- The system should answer from captured evidence and say when evidence is missing.
- Background speech should not become an implicit command.
- ClawSense does not make automatic micro-expression, emotion, or inner-state conclusions from faces or images.

## Recommended Model Setup

ClawSense is designed for OpenClaw instances driven by native multimodal models.

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

ClawSense does not currently replace its working ingest path with the official OpenClaw Android Companion protocol.

The intended long-term direction is:

- official OpenClaw control-plane compatibility for device presence, pairing semantics, and on-demand commands
- ClawSense data-plane retention for continuous audio/image/video ingest, event indexing, media storage, and daily review

That means the future target is a hybrid architecture, not a full rewrite of the current MVP transport.

## Product Entry Points

ClawSense currently has three user-facing entry points, and each one has a different job:

- `openclaw clawsense devices`: confirm which Android node is paired and still alive.
- `openclaw clawsense media today` or `/plugins/clawsense/library`: browse the raw perception library by date, device, audio, image, and video.
- `openclaw clawsense review today` or the repo-local Daily Review skill: generate the assistant-style recap with people, projects, details, follow-up questions, and tomorrow focus.

## Media Library Access Model

ClawSense media browsing follows one hard rule: it should reuse the same host and origin the user already uses for OpenClaw.

So the intended default shape is:

- if a user opens OpenClaw at `http://1.2.3.4:18789/`, the library should live at `http://1.2.3.4:18789/plugins/clawsense/library`
- if a user opens OpenClaw at `https://example.com/`, the library should live at `https://example.com/plugins/clawsense/library`

The media library is meant to be a same-host, same-origin, lightweight page. Export stays as a secondary capability for offline backup or sharing, not the main browsing path.

## More Project Docs

- [当前阶段交付收口清单](./docs/当前阶段交付收口清单.md)
- [当前阶段分批提交计划](./docs/当前阶段分批提交计划.md)
- [当前阶段正式收口总结](./docs/当前阶段正式收口总结.md)
- [v0.1.0 Beta Readiness](./docs/releases/v0.1.0-beta-readiness-2026-07-14.md)
- [小白部署与使用指南](./docs/小白部署与使用指南.md)
- [架构师交接摘要](./docs/架构师交接摘要.md)
- [多 Agent 协作分工说明](./docs/多Agent协作分工说明.md)
- [GitHub 与 npm 发布清单](./docs/GitHub与npm发布清单.md)
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
openclaw clawsense video-config
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
2. Open the media library on the same host you already use for OpenClaw to verify the raw audio, image, and video/keyframe timeline for the day.
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

# Android Video M2 recommended mode: accept 6s MP4 clips + keyframe evidence
openclaw config set plugins.entries.clawsense.config.hostModelVideoMode "\"keyframes\"" --strict-json
openclaw clawsense video-config

# conservative fallback mode (audio 先走 ASR，图像仅元数据)
openclaw config set plugins.entries.clawsense.config.hostModelAudioMode "\"asr-first\"" --strict-json
openclaw config set plugins.entries.clawsense.config.hostModelImageMode "\"metadata-only\"" --strict-json

openclaw gateway restart --json || openclaw gateway start --json
```

For Android Video M2, `hostModelVideoMode=keyframes` is the recommended MVP setting. In this mode the old phone uploads a 6-second video-only MP4 plus start/end keyframes, and the media library/evidence layer can link keyframe captions/OCR back to the original video segment. If the mode remains `none`, video upload intentionally fails with `video_ingest_disabled`.

### Copy-Paste Setup: Local Open-Source ASR

For realtime voice queries and historical audio evidence, ClawSense can use a local offline ASR model before falling back to any cloud STT provider. This is the preferred free-first path for personal and open-source deployments.

Supported local backends:

- `whisper` — recommended global baseline; works well for international users.
- `funasr` — recommended Chinese-first path; can expose sentence segments and optional speaker labels if the local FunASR model supports them.
- `sherpa-onnx-sensevoice` — legacy built-in SenseVoice path; kept for existing deployments.

Whisper example using the bundled faster-whisper wrapper:

```bash
python3 -m pip install faster-whisper
chmod +x /absolute/path/to/ClawSense/scripts/local-asr/whisper-faster.py

openclaw config set plugins.entries.clawsense.config.localAsrBackend "\"whisper\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrWhisperCommand "\"/absolute/path/to/ClawSense/scripts/local-asr/whisper-faster.py\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrWhisperModel "\"small\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrLanguage "\"zh\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrTimeoutMs "120000" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

FunASR example using the bundled local wrapper:

```bash
python3 -m pip install funasr modelscope
chmod +x /absolute/path/to/ClawSense/scripts/local-asr/funasr-local.py

openclaw config set plugins.entries.clawsense.config.localAsrBackend "\"funasr\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrFunAsrCommand "\"/absolute/path/to/ClawSense/scripts/local-asr/funasr-local.py\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrFunAsrModel "\"iic/SenseVoiceSmall\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrLanguage "\"zh\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrTimeoutMs "120000" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

WhisperX optional speaker diarization spike:

```bash
python3 -m venv .local/asr/whisperx-venv
. .local/asr/whisperx-venv/bin/activate
python -m pip install -U pip
python -m pip install whisperx
chmod +x /absolute/path/to/ClawSense/scripts/local-asr/whisperx-local.py

# Optional but required for pyannote speaker labels.
# You must accept the relevant pyannote model terms in Hugging Face first.
scripts/local-asr/save-hf-token.sh
source .local/asr/hf-token.env

openclaw config set plugins.entries.clawsense.config.localAsrBackend "\"whisper\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrWhisperCommand "\"/absolute/path/to/ClawSense/scripts/local-asr/whisperx-local.py\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrWhisperModel "\"small\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrLanguage "\"zh\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrTimeoutMs "600000" --strict-json
openclaw gateway restart --json || openclaw gateway start --json

# Read-only check: does this route actually produce speaker labels?
openclaw clawsense diarization-probe 2026-06-25 --provider whisperx --max 1
```

If `HF_TOKEN` is missing or pyannote cannot run, `whisperx-local.py` degrades to ASR-only output. That is still useful for transcripts, but `speakerReady` will remain false. WhisperX speaker diarization also requires the original audio file to still exist on disk; historical transcript-only records cannot be re-diarized without their source audio.

Hybrid WhisperX + FunASR/CAM++ speaker-label spike:

```bash
# This route keeps WhisperX/Whisper for transcript quality and uses FunASR/CAM++
# only as a local speaker timeline. It does not require pyannote gated access.
chmod +x /absolute/path/to/ClawSense/scripts/local-asr/hybrid-whisper-funasr.py

openclaw config set plugins.entries.clawsense.config.localAsrBackend "\"whisper\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrWhisperCommand "\"/absolute/path/to/ClawSense/scripts/local-asr/hybrid-whisper-funasr.py\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrWhisperModel "\"small\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrLanguage "\"zh\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrTimeoutMs "600000" --strict-json

# The hybrid wrapper calls two child commands. Use runner scripts when the
# dependencies live in virtualenvs.
export CLAWSENSE_HYBRID_ASR_COMMAND="/absolute/path/to/ClawSense/.local/asr/whisperx-runner.sh"
export CLAWSENSE_HYBRID_SPEAKER_COMMAND="/absolute/path/to/ClawSense/.local/asr/funasr-runner.sh"
export CLAWSENSE_HYBRID_FUNASR_MODEL="iic/SenseVoiceSmall"
export CLAWSENSE_HYBRID_SPEAKER_MODEL="cam++"

openclaw clawsense diarization-probe 2026-06-25 --provider hybrid --max 1
```

Use `hybrid` as a practical open-source fallback when pyannote is blocked. The transcript comes from WhisperX/Whisper; speaker labels are assigned by time overlap from FunASR/CAM++, so long transcript segments may only get the dominant speaker rather than word-level attribution. Numeric speaker ids from local tools are normalized into `speaker_1`, `speaker_2`, etc. so user annotations can attach consistently.

For Chinese meeting-heavy deployments, prefer FunASR as the primary transcript source. The same hybrid wrapper can run FunASR/SenseVoice for transcript and FunASR/CAM++ for speaker timeline:

```bash
export CLAWSENSE_HYBRID_ASR_COMMAND="/absolute/path/to/ClawSense/.local/asr/funasr-runner.sh"
export CLAWSENSE_HYBRID_SPEAKER_COMMAND="/absolute/path/to/ClawSense/.local/asr/funasr-runner.sh"
export CLAWSENSE_HYBRID_FUNASR_MODEL="iic/SenseVoiceSmall"
export CLAWSENSE_HYBRID_SPEAKER_MODEL="cam++"
export CLAWSENSE_FUNASR_PUNC_MODEL="none"
```

Optional public Chinese meeting checks:

```bash
npm run check:public-zh-meeting
CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting
CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting
npm run check:public-zh-replay
```

Validation notes live in [docs/validation/README.md](./docs/validation/README.md). Public-sample ASR details are in [docs/validation/local-asr-public-sample-validation-2026-07-02.md](./docs/validation/local-asr-public-sample-validation-2026-07-02.md).

Legacy sherpa-onnx/SenseVoice example:

```bash
openclaw config set plugins.entries.clawsense.config.localAsrBackend "\"sherpa-onnx-sensevoice\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrModelDir "\"/absolute/path/to/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrLanguage "\"zh\"" --strict-json
openclaw config set plugins.entries.clawsense.config.localAsrNumThreads "2" --strict-json
openclaw gateway restart --json || openclaw gateway start --json
```

When enabled, audio transcription tries:

1. OpenClaw runtime STT
2. local offline ASR
3. primary multimodal audio understanding
4. OpenAI-compatible STT fallback

The local command wrapper may output plain text or JSON. JSON can include `transcript`/`text` and optional `segments` with `startMs`, `endMs`, `text`, `speakerLabel`, and `confidence`. ClawSense stores these as `transcriptSegments`, so later review questions can reason over smaller speech spans instead of one coarse audio blob.

Historical ASR worker:

```bash
# First inspect the local backend.
openclaw clawsense asr-status

# Safe dry-run on one date. This does not write transcripts back.
openclaw clawsense asr-worker run-once 2026-06-25 --dry-run --max 3 --batch 1

# Safe dry-run with explicit speaker diarization env for a WhisperX wrapper.
openclaw clawsense asr-worker run-once 2026-06-25 \
  --provider local-asr \
  --diarization-provider whisperx \
  --dry-run \
  --max 1 \
  --batch 1

# Or use the hybrid fallback when pyannote gated access is unavailable.
openclaw clawsense asr-worker run-once 2026-06-25 \
  --provider local-asr \
  --diarization-provider hybrid \
  --dry-run \
  --max 1 \
  --batch 1

# When dry-run looks healthy, run a small real batch.
openclaw clawsense asr-worker run-once 2026-06-25 --max 3 --batch 1

# If the WhisperX dry-run shows speaker labels, write back only a tiny batch first.
openclaw clawsense asr-worker run-once 2026-06-25 \
  --provider local-asr \
  --diarization-provider whisperx \
  --max 1 \
  --batch 1

# Optional automatic background worker. Keep small batches on low-power hosts.
openclaw config set plugins.entries.clawsense.config.asrWorkerEnabled true --strict-json
openclaw config set plugins.entries.clawsense.config.asrWorkerIntervalSeconds 900 --strict-json
openclaw config set plugins.entries.clawsense.config.asrWorkerBatchSize 1 --strict-json
openclaw config set plugins.entries.clawsense.config.asrWorkerMaxJobs 12 --strict-json
openclaw config set plugins.entries.clawsense.config.asrWorkerLookbackDays 2 --strict-json
openclaw config set plugins.entries.clawsense.config.asrWorkerProvider "\"local-asr\"" --strict-json
openclaw config set plugins.entries.clawsense.config.asrWorkerIncludeTranscribed true --strict-json
openclaw gateway restart --json || openclaw gateway start --json

openclaw clawsense asr-worker status
```

The worker is disabled by default because local ASR can be CPU-heavy. Start with `--dry-run`, keep `asrWorkerBatchSize` small, and only enable background processing after `asr-status` reports `ready=true`.

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
- video acceptance is now tracked as `video-evidence`; for Android Video M2 validation, set `hostModelVideoMode=keyframes` before expecting `/ingest/video` to accept MP4 uploads
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
- if raw artifacts grow past that cap, the host will delete the **oldest audio/image/video originals first**
- event indexes and daily reviews stay available even after the raw files are removed
- you can change the cap with plugin config `maxArtifactBytes`
- set `maxArtifactBytes` to `0` if you explicitly want to disable the size cap

If you do **not** want ClawSense to auto-delete raw audio/image/video originals:

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
