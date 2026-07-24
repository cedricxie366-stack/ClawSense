# Local OpenClaw evidence CLI 验收说明

## 目标

这个验收用 repo-local OpenClaw runtime 的真实 state 检查聊天证据链，而不是 synthetic fixture。

它验证：

- `clawsense context --question ...` 能推断到指定历史日期。
- 历史会议问题优先暴露 `transcriptSpans`，而不是只看图片。
- `topicSegments`、`taskAttribution`、`evidenceFollowUpTargets` 能通过真实 OpenClaw CLI 输出。
- `memory-cards --format markdown` 能把长期记忆卡片沉淀为带证据链的 Markdown 报告。
- `history --question ...` 能输出人物 / 项目历史对象，并在有目标时带出关联 `memoryCards`。
- `refresh-semantics [date]` 能把旧历史事件按当前规则重算 `projectRefs/tags`，让旧素材吃到新的办公业务主线抽取。
- 当真实 state 没有 speaker timeline / speaker 标注时，任务归属应保持 `needs-speaker-labels`，不能硬说“这是你的任务”。
- `speaker-slots` 应输出 `slotTaskImpacts`：告诉用户标注哪个 speaker slot 可能影响哪些任务归属，并标明是否还需要 diarization 才能精确判断。
- `audio-diagnostics` 应输出 `blockers` / `nextActions`：当 raw audio 已被 retention 删除时，必须明确说明不能直接补跑本地 ASR / diarization。

## 一键命令

如果刚刚改过 Host 插件源码，先同步 repo-local OpenClaw runtime：

```bash
scripts/local-openclaw.sh setup
```

否则 `npm run build` 只会更新当前仓库的 `dist/`，不会自动替换 `.local/openclaw/state/extensions/clawsense` 中正在被 OpenClaw CLI 加载的插件版本。

```bash
npm run check:evidence-local
```

默认验证日期是 `2026-06-25`。如果验证其它日期：

```bash
CLAWSENSE_EVIDENCE_SMOKE_DATE=2026-05-11 npm run check:evidence-local
```

如需自定义问题：

```bash
CLAWSENSE_EVIDENCE_SMOKE_DATE=2026-06-25 \
CLAWSENSE_EVIDENCE_SMOKE_QUESTION='6 月 25 日会议里，有哪些任务落到我身上？' \
npm run check:evidence-local
```

默认日期下，这条命令还会额外验证：

- `refresh-semantics 2026-06-25` dry-run 可扫描历史事件
- `history 2026-06-25 --question 'AI 陪练这个项目之前在我的历史记忆里出现过什么？' --type project` 能返回 `AI 陪练` 项目历史
- 项目历史第一条 `recentMoment` 必须优先带 `transcriptExcerpt`

## 预期结果

成功时会输出 JSON：

- `ok: true`
- `context.date` 等于目标日期
- `context.transcriptSpanCount > 0`
- `context.topicSegmentCount > 0`
- `context.taskCandidateCount > 0`
- `followups.evidenceFollowUpTargetCount > 0`
- `memoryCards.count > 0`
- `memoryCards.matchCount > 0`
- `memoryCardMatches` / Markdown 报告应包含 `retrievalRank`、`score`、`matchReasons` 或对应的“检索排序”说明
- `context.contextAudioRawAudioArtifacts` 应和 `audioDiagnostics.verdict.rawAudioArtifacts` 保持一致
- `context.contextAudioBlockerIds` 应把关键阻塞项暴露给 OpenClaw 主模型，例如 `raw-audio-retention-deleted`
- `audioDiagnostics.blockerIds` 应列出当前音频诊断阻塞项
- `audioDiagnostics.nextActionCount > 0`，确保验证线程能看到下一步动作

如果 `context.contextAudioRawAudioArtifacts` 缺失，通常不是素材问题，而是 repo-local runtime 还在加载旧插件。先运行：

```bash
scripts/local-openclaw.sh setup
```

再重新执行 `npm run check:evidence-local`。

## 手动检查 speaker 任务归属辅助

```bash
scripts/local-openclaw.sh openclaw clawsense speaker-slots 2026-06-25 \
  --question '6 月 25 日会议里，有哪些明确分配给我的任务？哪些只是别人提到但没有落到我身上的？'
```

成功时应满足：

- `status` 为 `needs-speaker-labels`，或在已充分标注时进入更明确的可归属状态。
- `slotTaskImpacts` 非空，并包含 `speakerRef`、`sampleTasks`、`requiresDiarization`。
- `commands.markAsMe` 和 `commands.markAsColleague` 可复制执行。
- 如果 `impactLevel` 是 `window-context-only`，回答必须说明这只是窗口级上下文，不能替代句子级 speaker / diarization。

## 手动检查记忆卡片报告

只看 Markdown，不落盘：

```bash
scripts/local-openclaw.sh openclaw clawsense memory-cards \
  --question '6 月 25 日会议里，有哪些任务落到我身上？' \
  --format markdown
```

写入 ClawSense drafts 目录：

```bash
scripts/local-openclaw.sh openclaw clawsense memory-cards \
  --question '6 月 25 日会议里，有哪些任务落到我身上？' \
  --title '6 月 25 日会议任务沉淀' \
  --writeDraft
```

成功时 JSON 里会返回 `draft.filePath`。报告必须包含 `## 总览`、`## 与当前问题最相关`，并保留 `检索排序`、`证据时间` / `转写摘录` 等回链信息。

## 手动检查人物 / 项目历史记忆

人物历史：

```bash
scripts/local-openclaw.sh openclaw clawsense history \
  --question 'Amy 之前在我的历史记忆里出现过什么？' \
  --type identity
```

项目历史：

```bash
scripts/local-openclaw.sh openclaw clawsense history 2026-06-25 \
  --question '这个项目之前在我的历史记忆里出现过什么？' \
  --type project
```

成功时应返回 `ok: true`。如果当前 state 里有可解析的人物 / 项目目标，`identityHistory` 或 `projectHistory` 会包含 `recentMoments` 和关联 `memoryCards`；如果没有目标，返回空历史是允许的，但不应报错。

## 手动刷新旧素材语义索引

当代码新增了项目抽取规则，但旧历史素材还是没有 `projectHistory` 时，先 dry-run：

```bash
scripts/local-openclaw.sh openclaw clawsense refresh-semantics 2026-06-25 --max-samples 5
```

确认 `changedEvents` 和 `sampleChanges` 合理后，再写回 repo-local state：

```bash
scripts/local-openclaw.sh openclaw clawsense refresh-semantics 2026-06-25 --apply --max-samples 5
```

写回后再查项目历史：

```bash
scripts/local-openclaw.sh openclaw clawsense history 2026-06-25 \
  --question 'AI 陪练这个项目之前在我的历史记忆里出现过什么？' \
  --type project
```

预期至少包含：

- `summary.projectCount > 0`
- `projectHistory[0].label` 能显示中文业务名，例如 `AI 陪练`
- `projectHistory[0].recentMoments[0]` 优先是有 `transcriptExcerpt` 的音频窗口，而不是低信息黑屏窗口
- `projectHistory[0].memoryCards` 在有长期卡片时应非空

如果失败，通常说明 repo-local runtime 没有对应日期素材，或聊天证据路由被改坏。

## 手动检查音频诊断阻塞原因

```bash
scripts/local-openclaw.sh openclaw clawsense audio-diagnostics 2026-06-25
```

重点看：

- `verdict.rawAudioArtifacts`
- `counts.diarizationNeededEvents`
- `counts.diarizationRunnableEvents`
- `blockers`
- `nextActions`

如果 `rawAudioArtifacts` 是 `deleted`，应出现 `raw-audio-retention-deleted` blocker。此时可以继续基于已保存 transcript 回顾当天内容，但不能从当前 state 直接补跑本地 ASR / diarization；要么重新导入 raw wav，要么采集一段新的仍在 retention 窗口内的音频。
