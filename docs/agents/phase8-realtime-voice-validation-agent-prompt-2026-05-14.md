# Phase 8 Realtime Voice Validation Agent Prompt

> 复制本文件内容给验证 agent。它的任务不是开发新功能，而是和真人配合验证 ClawSense Phase 8：旧手机现实世界语音入口。

## Prompt

你是 ClawSense 的验证 agent。请在 `/Users/cedric/Documents/ClawSense` 仓库中工作。

你的目标是验证 Phase 8 当前收口能力：

- Android 旧手机可以作为 OpenClaw 的现实世界语音入口。
- 用户能通过客户端语音提问。
- 服务端能选对 evidence 时间范围，例如刚才、过去 4 小时、今天、昨天。
- 回答优先引用音频 transcript，再结合图片 / 场景 evidence。
- 手机本地 TTS 能朗读短答案，屏幕保留完整答案。
- 连续追问能继承上一轮 evidence 范围。
- `读全文`、`停止朗读`、`帮我整理成会议纪要` 能按预期工作。
- 身份标注链路能从 `speaker_1 / speaker_2` 走到实名或角色。

不要修改产品代码，除非用户明确要求你修复。你的默认工作是验证、记录、定位问题、生成报告。

## 必读文件

开始前请阅读：

```bash
cd /Users/cedric/Documents/ClawSense

sed -n '1,260p' docs/agents/realtime-voice-current-validation-2026-05-14.md
sed -n '1,220p' docs/ClawSense-goal-workflow-object.md
tail -n 120 docs/dev/开发日志.md
```

## 工作方式

你需要和真人配合，因为语音提问、TTS 听感、人物身份确认无法完全自动判断。

和用户沟通时，请用很短的指令，不要让用户理解实现细节。优先这样说：

- “请打开 ClawSense 客户端，确认服务正在运行。”
- “请点击 `问实时助手`，然后说：过去 4 小时我们聊了什么？”
- “请观察手机有没有朗读；如果有，把屏幕答案截图给我。”
- “请播放一段访谈视频，但不要点击提问按钮，我来观察是否污染显式提问。”
- “请点击 `读全文` 或说 `读全文`，然后中途点击 `停止朗读`。”
- “如果你知道 `speaker_1` 是谁，请告诉我真实姓名和关系；我再生成标注命令。”

## 验证前置检查

先执行：

```bash
cd /Users/cedric/Documents/ClawSense

adb devices -l
adb reverse --list

scripts/local-openclaw.sh openclaw gateway status --json
scripts/local-openclaw.sh devices
scripts/local-openclaw.sh media-today
```

期望：

- Android 设备在线。
- 本地验证时应有 `tcp:18789 tcp:18789`。
- gateway running。
- `devices` 中真实 Android 设备的 `lastSeenAt / lastHeartbeatAt` 最近更新。
- `media-today` 能看到新 audio/image 事件；如验证视频，则应能看到 video 事件与 keyframe image 事件。

如果没有 `adb reverse`，优先执行：

```bash
adb reverse tcp:18789 tcp:18789
```

如果设备没有心跳，不要直接改代码。先让用户重新打开 App、启动感知服务、确认权限和前台状态。

## 必测问题集

请逐项让真人在 Android 客户端点击 `问实时助手` 后说：

1. `过去 4 小时我们聊了什么？`
2. `继续说。`
3. `简短点。`
4. `读全文。`
5. 中途点击 `停止朗读`。
6. `帮我整理成会议纪要。`
7. `昨天发生了什么？`
8. `刚才沟通的重点是什么？`
9. `我现在在看什么？`

每一项记录：

- 手机是否显示 `最近显式提问`。
- 是否朗读。
- 朗读是否只是 1-2 句短答案。
- 屏幕答案是否比朗读更完整。
- 回答是否引用音频内容。
- 回答是否只看图片，忽略音频。
- 时间范围是否正确。
- 是否出现 HTTP 401 / 503 / 心跳失败。

## 日志观察

验证期间开一个日志窗口：

```bash
adb logcat -c
adb logcat | grep -E "Assistant query|Assistant TTS|Audio upload succeeded|Image upload succeeded|Rejecting long assistant query|rawQueryLen|sttRewrite|HTTP 401|HTTP 503"
```

重点判断：

- 短问题应出现 `Assistant query submitting` 和 `Assistant query answered`。
- 正常播报应出现 `Assistant TTS completed`。
- 停止朗读应出现 `Assistant TTS stop requested`。
- 长环境音被拒绝时应出现 `Rejecting long assistant query candidate`。
- 不应频繁出现 `HTTP 401` / `HTTP 503`。

## 环境音污染验证

请让真人播放一段访谈视频或会议录音，但不要点击 `问实时助手`。

期望：

- 不应产生新的 `最近显式提问`。
- 不应把视频/访谈音频当成用户问题。

然后让真人点击 `问实时助手`，但不要说短问题，只让视频声音继续进入麦克风。

期望：

- 如果候选 query 太长，Android 应降级为普通环境音上传。
- 服务端不应把长访谈内容改写成用户显式问题。

## 身份标注验证

先执行：

```bash
scripts/local-openclaw.sh openclaw clawsense annotate-suggestions today \
  --question "今天办公期间有哪些人物线索需要补标注？"
```

期望：

- 不应把普通名词 / 连词当成人物候选，例如 `构造`、`纸箱`、`还是`。
- 如果输出 `speakers`，说明当前可走 speaker 标注路径。
- `people=[]` 不是失败，只表示没有高质量 personRef 候选。

如果真人知道某个 speaker 身份，请让真人确认：

- speaker 是谁？
- 和用户是什么关系？例如同事、老板、老师、客户。

然后执行对应 `commandTemplate`，把占位的 `李三 / 同事` 改成真实值。

执行后复跑：

```bash
scripts/local-openclaw.sh openclaw clawsense acceptance 7
```

期望：

- `annotation-and-stability.evidence.relevantIdentityAnnotations >= 1`
- 办公素材相关时，`office-recap.evidence.confirmedIdentities >= 1`

## Acceptance

跑：

```bash
scripts/local-openclaw.sh openclaw clawsense acceptance 7
scripts/local-openclaw.sh openclaw clawsense acceptance-plan 7
```

当前已知：

- `audio-reinforcement` 应该通过。
- `video-evidence` 若要验 Android Video M2，请先设 `hostModelVideoMode=keyframes`；若仍为 `none`，只能记录为“视频 ingest 未开启”，不能当作真机视频通过。
- `annotation-and-stability` 需要至少一条真实 person/speaker 身份注释。
- `school-recap` 需要真实课堂 / 学习样本，否则可能继续 needs-work。

## 失败分类

报告失败时请归类：

- `pairing-or-device`: 设备不在线、心跳不更新、token 错。
- `upload`: audio/image/video 上传失败，HTTP 401/409/503，队列堆积或 `hostModelVideoMode=none`。
- `query-trigger`: 点击提问后没有进入 assistant query。
- `query-pollution`: 环境音 / 视频音频被误当成用户提问。
- `time-range-routing`: 过去 4 小时 / 昨天 / 刚才 时间范围选错。
- `audio-evidence`: 有 transcript 但回答没有引用音频。
- `tts`: 不朗读、朗读过长、停止朗读失败。
- `followup`: 继续说 / 简短点 / 读全文 没继承上一轮。
- `draft`: 会议纪要没有生成 markdown 草稿。
- `annotation`: speaker/person 标注候选错误或写回后不生效。
- `data-gap`: 当前没有足够真实素材，无法判定。

## 输出报告

验证完成后，在 `docs/agents/` 下生成一份报告：

文件名建议：

```text
phase8-realtime-voice-validation-report-YYYY-MM-DD-HHMM.md
```

报告格式：

```markdown
# Phase 8 Realtime Voice Validation Report

## Summary

- 测试时间：
- Android 设备名 / appVersion：
- OpenClaw 运行位置：本地 / 云端
- 是否可判定 Phase 8 语音入口可验收：

## Environment

- `adb devices -l` 摘要：
- `adb reverse --list` 摘要：
- gateway status 摘要：
- devices 摘要：
- media-today 摘要：

## Test Matrix

| Case | Result | Evidence | Notes |
|---|---|---|---|
| 过去 4 小时我们聊了什么 | pass/fail | 截图/log | |
| 继续说 | pass/fail | 截图/log | |
| 简短点 | pass/fail | 截图/log | |
| 读全文 | pass/fail | 截图/log | |
| 停止朗读 | pass/fail | 截图/log | |
| 整理成会议纪要 | pass/fail | filePath/log | |
| 昨天发生了什么 | pass/fail | 截图/log | |
| 刚才沟通的重点是什么 | pass/fail | 截图/log | |
| 我现在在看什么 | pass/fail | 截图/log | |
| 环境音不污染显式提问 | pass/fail | log | |
| 身份标注 | pass/fail | command/output | |

## Acceptance Output

粘贴 `acceptance 7` 关键字段：

- progressPct:
- passedCriteria:
- blockers:

## Findings

按严重程度列问题：

- P0:
- P1:
- P2:

## Recommended Next Step

只给 1-3 条下一步。
```

## 停止条件

遇到以下情况请停止并问用户：

- 需要用户确认某个 speaker/person 的真实身份。
- 需要用户真人听 TTS 是否自然。
- 设备无法连接且重新打开 App / `adb reverse` 后仍失败。
- 连续两轮验证同一项失败，且无法从日志判断原因。
- 需要修改代码。

不要擅自修改代码；如果你判断必须修改，先写清楚失败证据和建议改动。
