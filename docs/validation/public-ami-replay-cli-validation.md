# Public AMI replay CLI validation

## 目标

把公开 AMI hybrid ASR 结果写入 repo-local OpenClaw state，并通过真实 CLI 验证：

- replay 后 `clawsense context` 能读到音频 transcript evidence。
- replay 后 `clawsense followups` 能产生统一追问目标。
- `annotate-speaker` 写回后，后续 context 能复用 speaker 身份。

这比纯 synthetic smoke 更接近用户实际聊天页路径，因为它会真实写入 `.local/openclaw/state` 并调用本地 OpenClaw CLI。

## 命令

```bash
npm run check:public-replay
```

该命令会先执行：

```bash
npm run check:public-wav
```

确保 AMI WAV 和 cached hybrid 结果存在，然后运行：

```bash
node ./scripts/check-public-ami-replay-cli-smoke.mjs
```

## 默认隔离日期

默认 replay 日期是：

```text
2026-01-15
```

原因：避免污染用户真实的 `2026-06-25` 历史素材。

可通过环境变量覆盖：

```bash
CLAWSENSE_PUBLIC_AMI_REPLAY_DATE=2026-01-16 npm run check:public-replay
```

## 在当前阶段门禁中的用法

`npm run check:phase` 会把 `CLAWSENSE_PUBLIC_AMI_REPLAY_DATE` 覆盖为当天日期，并把公开 AMI replay 纳入阶段断言。

原因：

- 独立运行 `check:public-replay` 时默认写入 `2026-01-15`，避免污染真实历史日期。
- 阶段门禁需要在最近 7 天 acceptance 窗口内制造一段可复现办公会议素材，所以会临时写入当天日期。
- 私有 AMI fixture `.local/test-fixtures/ami-es2002a/raw/ES2002a.Mix-Headset.wav` 不存在时，阶段门禁会跳过旧 fixture，并以公开 AMI replay 的 transcript / followups / speaker annotation 作为办公场景证据。

## 写入内容

脚本会从 `.local/asr/results/evidence-v2-ami-hybrid-*.json` 读取 AMI hybrid 结果，并写入：

- 36 条 audio event
- 每条 event 带 `transcript`
- 每条 event 带 `transcriptSegments`
- 每条 event 带 `speakerTimelineSegments`
- `note` 包含 `fixture=public-ami-hybrid`

脚本每次运行前只清理自己上一轮写入的同名 fixture：

- note 包含 `fixture=public-ami-hybrid` 的 events
- storageRelPath 包含 `fixtures/public-ami-hybrid/` 的 artifacts
- speakerRef / windowId / notes 中含该 fixture 的 speaker annotations
- 默认隔离日期的 cached review / consolidation

## 验收断言

### replay 后 context

固定问题：

```text
2026-01-15 公开 AMI 会议里，刚才讨论的重点是什么？
```

要求：

- `date=2026-01-15`
- `windowCount >= 1`
- `transcriptSpanCount >= 10`
- `topicSegmentCount >= 1`
- `evidenceFollowUpTargetCount >= 1`
- `speaker_2` 在标注前存在但没有 displayName

### speaker 标注

脚本会实际执行：

```bash
openclaw clawsense annotate-speaker <speaker_2_ref> Sarah --relationship "project manager"
```

然后再次提问：

```text
2026-01-15 公开 AMI 会议里，Sarah 说了什么？
```

要求：

- 后续 context 的 speaker slot 中出现 `displayName=Sarah`
- context text 或 response hints 能暴露 `Sarah`
- followups 仍然可用

## 通过示例

```json
{
  "ok": true,
  "replay": {
    "fixtureDate": "2026-01-15",
    "segmentCount": 36
  },
  "before": {
    "transcriptSpanCount": 12,
    "topicSegmentCount": 2,
    "evidenceFollowUpTargetCount": 3
  },
  "annotation": {
    "displayName": "Sarah",
    "relationship": "project manager"
  },
  "after": {
    "transcriptSpanCount": 12,
    "topicSegmentCount": 2
  }
}
```

## 失败含义

- 缺 AMI result：先跑 `npm run check:public-wav`。
- context 没 transcript：说明 replay 写入或 evidence extraction 断了。
- annotate 后 Sarah 不出现：说明 speaker annotation 写回或 context 复用断了。
- followups 为空：说明统一追问入口在真实 local CLI 路径上回退。
