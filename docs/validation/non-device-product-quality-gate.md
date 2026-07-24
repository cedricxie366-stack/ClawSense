# Non-device product quality gate

## 目标

这个门禁用于回答一个很实际的问题：**真机暂时跑不了时，ClawSense 还能验什么？**

它覆盖当前 1-7 推进项里不依赖 Android 真机的部分：

1. 公开样例 replay 验证
2. ASR / diarization 正向链路
3. QA quality gate
4. 长历史召回与问题路由
5. speaker 标注与可观测性
6. 自动录视频触发 fixture
7. 文档与诊断工具入口

## 一键命令

```bash
npm run check:non-device-product-gate
```

该命令会先执行 `npm run build`，然后运行：

- `scripts/check-evidence-v2-smoke.mjs`
- `scripts/check-conversation-evidence-routing-smoke.mjs`
- `scripts/check-local-openclaw-evidence-smoke.mjs`
- `scripts/check-public-wav-asr-smoke.mjs`
- `scripts/check-public-ami-replay-cli-smoke.mjs`
- `openclaw clawsense memory-cards ...`
- `openclaw clawsense memory-cards --format markdown ...`
- `openclaw clawsense audio-diagnostics 2026-01-15`
- `openclaw clawsense speaker-slots 2026-01-15`
- `scripts/check-phase9-fixtures.mjs`
- 可选：`scripts/check-public-zh-meeting-replay-cli-smoke.mjs`

所有 OpenClaw 命令都通过 repo-local runtime 执行：

```bash
scripts/local-openclaw.sh openclaw ...
```

## 输出解释

成功时输出类似：

```json
{
  "ok": true,
  "report": {
    "path": "/Users/cedric/Documents/ClawSense/.local/non-device-product-gate-reports/non-device-product-gate-2026-07-13T17-25-48-127Z.json",
    "latestPath": "/Users/cedric/Documents/ClawSense/.local/non-device-product-gate-reports/latest.json"
  },
  "summary": {
    "passed": 9,
    "skipped": 0,
    "failed": 0,
    "realDeviceRequired": false
  }
}
```

每次运行都会落盘一份完整 JSON 报告，并更新 `latest.json`：

```bash
.local/non-device-product-gate-reports/latest.json
```

如只想读取最近一次报告摘要，不重跑完整门禁：

```bash
npm run report:non-device-product-gate
```

摘要会包含 `freshness` 字段。默认超过 24 小时标记为 stale；只读命令仍会输出摘要，但验收签核前应重跑完整门禁：

```bash
CLAWSENSE_NON_DEVICE_GATE_STALE_AFTER_HOURS=12 npm run report:non-device-product-gate
```

如需改报告目录：

```bash
CLAWSENSE_NON_DEVICE_GATE_REPORT_DIR=.local/custom-gate-reports npm run check:non-device-product-gate
```

如果本机缺少中文 AliMeeting fixture 缓存，`public-zh-replay-optional` 会变成 `skipped=1`；当前完整缓存环境下应为 `passed=9`、`skipped=0`。若希望把中文样例设为强制项：

```bash
CLAWSENSE_REQUIRE_PUBLIC_ZH_REPLAY=1 npm run check:non-device-product-gate
```

缺少中文公开样例缓存时，按输出的 `nextCommands` 准备：

```bash
CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting
CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting
npm run check:public-zh-replay
```

## 1-7 覆盖关系

| 推进项 | gate 覆盖 | 说明 |
| --- | --- | --- |
| 1. 公开样例 replay | `public-ami-asr-cache`、`public-ami-replay`、`public-zh-replay-optional` | AMI 为默认强制正向样例；中文 AliMeeting 为可选强化样例。 |
| 2. ASR / diarization | `public-ami-asr-cache`、`active-raw-audio-positive` | 确认 cached ASR 有 transcript、speaker timeline，并在 replay 后保留 active raw audio artifact。 |
| 3. QA quality gate | 本文档命令本身 | 把分散 smoke 组合成产品级非真机门禁。 |
| 4. 长历史召回与沉淀 | `conversation-routing`、`historical-real-state`、`memory-cards` | 验证 6 月 25 日历史问题不会只看最近图片，且能引用 transcript / digest / task attribution；`conversationDigest.taskMatches` 会暴露 speaker 标注边界和可复制命令；rolling digest 会沉淀为任务/话题/注意/学习卡片、可解释召回排序和可保存 Markdown 报告。 |
| 5. speaker 标注 UX | `speaker-slots-positive`、`public-ami-replay` | 验证 speaker slots 可观测，标注 Sarah 后可被后续 context 复用，并保护 `slotTaskImpacts` / 可复制标注命令 / diarization 需求提示。 |
| 6. 自动录视频触发 | `auto-video-trigger-fixture` | 验证触发词、低信号忽略、拥塞保护和 heartbeat directive 结构。 |
| 7. 文档 / 诊断工具 | 本文档、`audio-diagnostics`、`speaker-slots`、`memory-cards` | 验证线程可以直接根据 JSON 判断问题是 raw audio 删除、speaker 未标注、记忆卡未生成还是证据路由断裂。 |

## Synthetic 音频诊断正向样例

`evidence-v2-synthetic.summary` 会显示：

- `rawAudioArtifacts`
- `audioEvents`
- `transcriptReadyEvents`
- `speakerTimelineReadyEvents`
- `audioBlockerIds`

这条路径不依赖 repo-local state，也不需要真实 Android 设备。它用于快速保护“audioDiagnostics 已进入 evidence bundle / response hints”的正向契约；真实历史素材和 replay 则由后续 gate 项继续验证。

`conversation-routing.summary` 还会显示公开 AMI 对话包的音频诊断：

- `publicAmiRawAudioArtifacts`
- `publicAmiAudioEvents`
- `publicAmiTranscriptReadyEvents`
- `publicAmiSpeakerTimelineReadyEvents`
- `publicAmiAudioBlockerIds`

这条路径更接近用户真实问法，例如“刚才讨论的重点是什么”“过去 4 小时聊了什么”。如果这些字段消失，说明自然语言时间路由虽然可能仍可用，但对话 evidence 的音频状态可观测性已经退化。

## 历史真实素材音频诊断

`historical-real-state` 的 `summary` 会额外暴露：

- `contextRawAudioArtifacts`：OpenClaw 聊天 context / evidence bundle 里看到的 raw audio 状态。
- `contextAudioBlockerIds`：OpenClaw 主模型会看到的音频阻塞项。
- `contextAudioMatchesDiagnostics`：确认 context 层 verdict 和 CLI `audio-diagnostics` verdict 一致。
- `rawAudioArtifacts`：`available` 表示还能从当前 state 补跑本地 ASR / diarization；`deleted` 表示 raw wav 已被 retention 清理。
- `audioBlockerIds`：当前音频链路的关键阻塞原因，例如 `raw-audio-retention-deleted`。
- `audioNextActionCount`：是否已经给出人类可执行的下一步。

同时，`clawsense context/evidence` 的 evidence bundle 也会携带 `audioDiagnostics`。这层是给 OpenClaw 主模型看的：当 raw audio 已经删除时，context 不再把不可用的原始音频 URL 当作可复核音频暴露，而是明确提示“可引用已保存转写，但不能直接补跑本地 ASR / diarization”。

如果 `rawAudioArtifacts=deleted`，gate 会强制要求 CLI 和 context 两层都出现 `raw-audio-retention-deleted` blocker，并且 CLI 侧有可读 next actions。此时当天内容仍可基于已保存 transcript / digest 回顾，但不能直接从当前 state 重新跑本地 ASR 或说话人分离。

## 仍需真机验收的部分

这个 gate **不能替代**以下真人 / 真机验证：

- Android 麦克风是否能稳定采集真实人声。
- 语音提问是否能正确区分“环境音频”和“用户 query”。
- 手机 TTS 播报是否完整、自然、不会回灌进环境音频。
- 真机网络、配对、心跳、上传队列在弱网下是否稳定。
- 主动录视频 directive 是否在真实手机上按节流策略执行。

## 失败定位

- `historical-real-state` 失败：先看 `audio-diagnostics` 输出，判断是 transcript 缺失、raw audio retention 删除，还是 speaker timeline 缺失。
- `public-ami-asr-cache` 失败：先跑 `CLAWSENSE_PUBLIC_WAV_RUN_ASR=1 npm run check:public-wav` 重新生成 AMI cached result。
- `conversation-routing` 失败：说明长历史问题路由、conversation digest、speaker 标注前后任务归属或 `taskMatches` 标注提示契约断裂。重点检查未标注第一人称任务是否仍是 `needs-speaker-label`，并且是否输出 `resolutionMode`、`requiresDiarization` 和可复制 `selfCommandTemplate`。
- `public-ami-replay` 失败：说明 replay 写入 state、context 证据抽取、followup 或 speaker annotation 某一层断了。
- `historical-real-state` 里的 `memoryCardCount` / `memoryCardMatchCount` 为 0：说明 rolling digest 没有成功沉淀为长期记忆卡片，后续向量化对象会缺失。
- `memory-cards --format markdown` 输出缺少 `## 总览`、`## 与当前问题最相关`、`检索排序`、`证据时间` / `转写摘录`：说明记忆卡片到可保存报告或 embedding 前召回排序链路断裂。
- 同一任务 / 话题在多次 rolling digest 后生成多张近似 `memoryCards`：说明语义去重 / 证据归并失效，后续问答会被重复卡片污染。
- 人物 / 项目历史追问没有带出关联 `memoryCards`：说明长期记忆卡片没有进入自然追问链路，模型只能回到历史窗口摘要，无法稳定回答“这个人/项目之前有哪些任务、话题、注意点”。
- `active-raw-audio-positive` 失败：说明 replay 后 raw audio artifact 没有处于 available 状态，会影响后续 backfill / diarization。
- `speaker-slots-positive` 失败：说明 speaker 标注辅助面不可用。重点检查 `suggestedSlots` 是否存在、已标注人物是否复用、`slotTaskImpacts` 是否输出、`commands.markAsMe` / `commands.markAsColleague` 是否可复制，以及 `requiresDiarization` 是否如实说明仍需句子级 speaker。
- `auto-video-trigger-fixture` 失败：说明主动录视频规则、拥塞保护或端侧 directive 契约被改坏。
