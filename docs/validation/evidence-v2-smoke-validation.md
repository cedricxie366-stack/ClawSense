# Evidence v2 smoke 验收说明

## 目标

这个 smoke 用来验证 ClawSense 是否已经把细粒度音频证据正确交给 OpenClaw 的聊天回答层，尤其覆盖下面三个之前真实验收暴露的问题：

- 长会议不能只给粗摘要，要能产出可追问的话题段。
- 带 speaker 的句级时间线必须进入 `clawsense_context` 的 details，不能在 ASR 后丢失。
- “我负责……”这类第一人称任务，只有在 speaker 标注为用户本人时才能算用户任务；如果 speaker 已标注为 Amy，就必须归给 Amy。
- `audioDiagnostics` 必须进入 evidence bundle / response hints，让 OpenClaw 主模型知道 raw audio 当前是否可补跑 ASR / diarization。

## 一键命令

```bash
npm run check:evidence-v2
```

## 预期结果

命令成功时会输出 JSON，至少包含：

- `ok: true`
- `topicSegmentCount >= 1`
- `speakerTimelineSegmentCount >= 1`
- `rawAudioArtifacts: "available"`
- `audioBlockerIds` 包含 `audio-ready`；如果样例尚无 speaker timeline，也可以是 `diarization-runnable`
- `taskCandidates` 中有 `speakerDisplayName: "Amy"` 且 `userAssignmentStatus: "assigned-to-known-speaker"`
- `taskCandidates` 中有 `assigneeHint: "产品团队"` 且 `userAssignmentStatus: "not-user-unless-role-matches"`

## 验证线程如何使用

验证 agent 不需要真机、不需要下载 ASR 模型、不需要访问历史真实素材。直接在 repo 根目录执行：

```bash
cd /Users/cedric/Documents/ClawSense
npm run check:evidence-v2
```

如果失败，把完整 JSON 输出复制回主开发线程。这个 smoke 失败通常表示 Evidence v2 的问答上下文链路被改坏，而不是模型本身回答不好。
