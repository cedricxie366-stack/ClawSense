# Conversation evidence routing validation

## 目标

验证当前阶段最关键的三条产品闭环：

1. 公开会议 WAV 不只停留在 ASR smoke，而是能进入对话 evidence bundle。
2. `刚才 / 过去4小时 / 昨天 / 6月25日` 这类自然问题能选对时间范围。
3. speaker 标注会改变任务归属判断：未标注时保守，标注为“我”后才归给用户。

## 命令

```bash
npm run check:conversation-routing
```

该命令会先执行 `npm run build`，再运行：

```bash
node ./scripts/check-conversation-evidence-routing-smoke.mjs
```

## 覆盖内容

### 1. 公开 AMI 会议问答包

输入来源：

- `.local/asr/results/evidence-v2-ami-hybrid-*.json`
- 若本地没有结果，先跑：

```bash
npm run check:public-wav
```

断言：

- `transcriptSpans >= 10`
- `topicSegments >= 1`
- `audioCoverage.transcriptReadyWindows >= 1`
- `audioDiagnostics.verdict.rawAudioArtifacts = "available"`
- `audioDiagnostics.counts.transcriptReadyEvents >= 10`
- `audioDiagnostics.counts.speakerTimelineReadyEvents >= 10`
- `audioDiagnostics.blockerIds` 包含 `audio-ready`；如果样例尚无 speaker timeline，也可以是 `diarization-runnable`
- tool details 暴露 `speakerTimelineSegments`
- speaker 标注前后的任务归属会进入 `conversationDigest.taskMatches`；未标注第一人称任务应保留 `needs-speaker-label`，并附带 `resolutionMode`、`requiresDiarization` 与可复制标注命令。
- `responseHints.evidenceFollowUpTargets` 包含 audio/topic 追问目标
- tool text 明确提示模型优先使用音频转写，而不是只看图片

### 2. 时间范围路由

固定验证问题：

- `过去4小时我们聊了什么？`
- `昨天发生了什么？`
- `6月25日发生了什么？`
- `过去一小时有什么需要注意？`

断言：

- `过去4小时` 进入 4 小时 `custom-range`
- `昨天` 进入上一自然日
- `6月25日` 进入 `2026-06-25`
- `过去一小时` 至少进入 1 小时 evidence window，即使内部实现选择 `custom-range` 而不是 `last-hour`

### 3. speaker 标注闭环

同一段 synthetic 会议证据会跑两遍：

1. `speaker_1` 未标注：
   - `我负责整理会议纪要` 必须是 `needs-speaker-label`
   - 不能直接归给用户

2. `speaker_1` 标注为 `我`：
   - 同一句必须变为 `assigned-to-user`
   - `产品团队需要确认接口方案` 仍保持 `not-user-unless-role-matches`

## 通过示例

```json
{
  "ok": true,
  "publicAmi": {
    "transcriptSpanCount": 12,
    "topicSegmentCount": 2,
    "rawAudioArtifacts": "available",
    "audioBlockerIds": ["audio-ready"],
    "evidenceFollowUpTargetCount": 3
  },
  "timeRangeRouting": [
    { "question": "过去4小时我们聊了什么？", "scope": "custom-range", "durationMs": 14400000 },
    { "question": "昨天发生了什么？", "scope": "today" },
    { "question": "6月25日发生了什么？", "scope": "today", "date": "2026-06-25" }
  ],
  "speakerAnnotationLoop": {
    "unresolvedStatus": "needs-speaker-labels",
    "labeledStatus": "ready"
  }
}
```

## 失败含义

- 公开 AMI 失败：通常是本地缺少 AMI hybrid 结果，先跑 `npm run check:public-wav`。
- 时间范围失败：说明 `assistant-tool` 的自然语言范围推断可能回退，需要优先修复。
- speaker 闭环失败：说明任务归属又可能把未标注的第一人称任务误判为用户任务，必须在 release 前修复。
