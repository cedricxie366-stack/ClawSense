# ClawSense `/goal` Workflow Object

> 这份文档是给 Codex / 验收 agent / 后续接手线程使用的任务主对象。
> 它不是产品 README，也不是开发日志，而是当前项目的“持续目标容器”。

## 1. Goal

把 ClawSense 做成 OpenClaw 的现实世界语音入口：

- 旧手机持续采集现实世界的音频、图片、视频 evidence。
- OpenClaw 主模型基于 evidence 与用户自然对话。
- 用户可以语音追问“刚才 / 过去4小时 / 今天 / 昨天”发生了什么。
- 手机负责本地 TTS 播报摘要，同时保留完整屏幕答案。
- 用户可以继续要求解释、追问、读全文、停止朗读、整理成会议纪要 / 行动项 / 学习笔记。

长期方向是全天候多模态记忆层；当前 goal 收口“现实世界语音对话入口 + evidence 回答 + 视频关键帧证据链”的阶段性交付版本。

## 2. Object

```yaml
id: clawsense-realtime-voice-agent
owner: Cedric + Codex
status: active
phase: Phase 8 delivery closure + Video M1 evidence chain
updatedAt: 2026-05-30

longTermGoal:
  title: 全天候多模态 OpenClaw 记忆层
  outcome:
    - 记录全天语音、图片、视频细节
    - 形成可检索、可回放、可复核 evidence
    - 让 OpenClaw 能回答今天发生了什么、有什么需要注意、用户没注意到什么

currentGoal:
  title: 旧手机现实世界语音入口可发布
  outcome:
    - 用户能通过 Android 客户端语音向 OpenClaw 提问
    - 服务端能选对 evidence 范围
    - 主模型能基于 transcript + 图片/场景 evidence 自然回答
    - 手机能读摘要、显示全文、支持继续追问和停止朗读
    - 可把回答沉淀成 markdown 草稿
    - 上传后的视频片段、关键帧 caption/OCR、关键帧到视频片段的回链可被 evidence/followups/chat 消费
    - 当前 npm 包和安装入口可发布，开发-only 材料不会进入 runtime 包

freezeLine:
  inScope:
    - assistant/query 问答质量
    - 时间范围和 evidence 路由
    - TTS 摘要 / 读全文 / 停止朗读
    - 连续追问 previousTurn
    - draft_document 草稿文件
    - 视频 M1 evidence：上传后视频、关键帧 caption/OCR、offset/videoRequestId 回链
    - npm package boundary / install.sh / runtime skills
    - 真实办公/课堂验收
  outOfScopeUntilNextPhase:
    - 真正 speaker diarization
    - 整天 100% transcript 覆盖
    - 聚会主动洞察
    - Android 端 CameraX 视频录制 M2
    - 全天向量化记忆增强
    - 所有 provider 的完美配置矩阵

successCriteria:
  - id: voice-entry
    title: 语音入口可用
    mustPass:
      - 能问“过去4小时我们聊了什么”
      - 能问“昨天发生了什么”
      - 能问“刚才看到了什么”
      - 能问“你怎么看这件事”
      - 回答包含正确时间范围、音频转写、画面证据、主模型理解
  - id: follow-up
    title: 连续追问可用
    mustPass:
      - “继续说”承接上一轮问题和 evidence 范围
      - “简短点”给短版
      - “读全文”播报更完整内容
      - “停止朗读”能停止 Android 本地 TTS
  - id: persistence
    title: 可沉淀输出
    mustPass:
      - “帮我整理成会议纪要”触发 draft_document
      - 服务端生成 markdown 草稿
      - 回答返回文件路径或明确失败原因
  - id: audio-evidence
    title: 音频 evidence 被真正引用
    mustPass:
      - 有 transcript 时优先引用语音内容
      - 不再明明有音频却只回答图片
      - 环境音长转写不再被误当成用户问题
  - id: stability
    title: 可持续使用
    mustPass:
      - 心跳/上传失败不频繁打断
      - Android 服务可继续提问
      - 本地/云端运行态可验证
  - id: release-boundary
    title: 当前阶段可发布
    mustPass:
      - npm run check 通过
      - npm test 通过
      - npm run check:release 通过
      - Android assembleDebug 通过
      - repo-local OpenClaw 命令面可运行

currentState:
  completed:
    - evidence-first clawsense_context
    - recent-context: last_15s / last_60s / last_5m / custom / day
    - 日级 today/yesterday overview
    - assistant/query 模板兜底
    - assistant/query 主模型回答链路
    - previousTurn 连续追问首版
    - answerText / answerSpokenText 双通道
    - draft_document markdown 草稿首版
    - Android 本地 TTS
    - Android 停止朗读 action
    - 长范围问题自动路由到 custom/day evidence
    - assistant/query 空设备上下文自动回退同一媒体库证据
    - 环境音长转写不再被当成用户显式提问
    - custom range 的 TTS 播报稿已收敛，避免硬截断
    - 连续追问继承上一轮 evidence 时间范围
    - draft_document 草稿落盘并返回 filePath
    - `读全文 / 停止朗读` 服务端确定性控制
    - `朱全文 -> 读全文`、`间短点 -> 简短点` 等短控制 ASR alias
    - Phase 8 验收稳定性口径已拆分数据面与语义分析失败
    - 标注建议过滤伪人物噪声，并且 speaker/person 任一实名注释都可满足当前身份闭环验收
    - 视频 M1 已完成结构化 keyframe marker、caption/OCR、videoOffset、videoRequestId 聚合与 evidence/followups 回链
    - 发布边界门禁 `npm run check:release` 已落地并通过
    - 当前分批提交计划和交付收口清单已建立
    - repo-local OpenClaw 命令面已复测：status / acceptance / evidence-video / followups / acceptance-plan 可运行
    - Android debug 构建已复测通过
  needsVerification:
    - 真机模型回答链路是否稳定返回 answerSource=model
    - 真机“读全文”与“停止朗读”体验
    - 真机 TTS echo drain 是否避免把播报重新录成环境音
    - 真机背景视频/会议持续说话时是否不污染显式 query
    - 草稿文件路径是否能被用户/聊天页顺畅看到
    - 真实办公/课堂素材上的 4 小时回顾质量
    - 人物注释后是否能在聊天回答里自然复用实名 / 角色
    - 课堂 / 学习场景是否能沉淀待确认知识点和 speaker/person 线索
  knownRisks:
    - ASR 覆盖不足会让模型看不到真实会议内容
    - 手机连接旧 gateway 会误判代码无效
    - 过短 answerSpokenText 会让用户以为回答缺失
    - 过长 answerSpokenText 会降低实时互动感
    - 按钮触发后的短提问边界仍需要真人验证，避免背景声继续污染 query
```

## 3. Active Execution Plan

### Step A：交付边界收口

目标：先保证当前巨大 worktree 可以被审查、验证、分批提交、发布。

必须通过：

- `npm run check`
- `npm test`
- `npm run check:release`
- `JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew assembleDebug`
- repo-local `clawsense status / acceptance / evidence-video / followups / acceptance-plan`

### Step B：真机验收语音入口

目标：确认当前代码不是只在 helper 测试里成立，而是真机闭环成立。

验收问题：

- `昨天发生了什么？`
- `过去4小时我们聊了什么？`
- `继续说。`
- `简短点。`
- `读全文。`
- 点击 Android 端 `停止朗读`
- `帮我整理成会议纪要。`

期望结果：

- `昨天 / 过去4小时` 命中对应时间范围，不退回最近 60 秒。
- `继续说` 承接上一轮，而不是重新描述最近图片。
- `读全文` 明显比普通摘要读得更完整。
- `停止朗读` 立即停止本地 TTS，并保留屏幕文字。
- 会议纪要请求生成 markdown 草稿路径。

### Step C：修真机验收缺口

只修会阻塞当前 goal 的问题：

- query 文本误判
- time range 错误
- 有 transcript 但未引用
- TTS 控制失败
- draft_document 没落地
- answerSource 长期无法走 model

不在本阶段扩展：

- Android 端 CameraX 视频录制 M2
- speaker diarization
- 全天向量化

### Step D：分批提交 / 发布决策

完成以下交付物后，进入用户决策点：

- 当前能力 README 说明
- Android 使用说明
- 验收 agent prompt / checklist
- 一份真实验收报告
- 当前阶段正式收口总结
- 是否按 [当前阶段分批提交计划.md](/Users/cedric/Documents/ClawSense/docs/当前阶段分批提交计划.md) 进行 git commit / npm publish

## 4. Decision Points

只有遇到以下情况才停下来找用户决策：

- 需要引入新的重大依赖，例如端侧 wake word SDK、云端向量库、外部 ASR 服务。
- 需要改变公共接口或 OpenClaw 插件配置 schema。
- 需要迁移/重写本地 state 数据结构。
- 真机连续两轮验证失败，且问题无法通过本地复现定位。
- 需要在“云端优先”和“本机优先”之间重新取舍。
- 需要决定是否进入 Android 视频录制 M2、全天向量化记忆增强或正式 npm publish。

## 5. Recovery Protocol

任何新线程接手时，按这个顺序恢复上下文：

1. 读本文件。
2. 读 [当前目标与阶段记忆.md](/Users/cedric/Documents/ClawSense/docs/当前目标与阶段记忆.md)。
3. 读 [当前阶段交付收口清单.md](/Users/cedric/Documents/ClawSense/docs/当前阶段交付收口清单.md)。
4. 读 [当前阶段分批提交计划.md](/Users/cedric/Documents/ClawSense/docs/当前阶段分批提交计划.md)。
5. 读 [ClawSense-vNext-任务清单.md](/Users/cedric/Documents/ClawSense/docs/ClawSense-vNext-任务清单.md) 的 Phase 8 / Video M1。
6. 读 [开发日志.md](/Users/cedric/Documents/ClawSense/docs/dev/开发日志.md) 最新 5 条。
7. 跑最小验证：

```bash
npm run check
npm test
npm run check:release
cd android && JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew assembleDebug
```

## 6. Current Next Action

优先继续做：

1. 按分批提交计划继续做最终清点。
2. 真机验收语音入口和真实数据覆盖由验收线程继续推进。
3. 如果验收失败，按失败类型回到 Step C，只修当前 goal 阻塞项。
4. 若代码、文档、包边界、Android 构建和 repo-local 命令面都稳定，则进入用户决策点：是否分批提交 / 发布 / 开启 Android 视频 M2。

当前不主动进入 Android 视频 M2，除非用户明确拍板；视频 M1 的上传后 evidence 链按当前阶段收口处理。

2026-05-30 最新进展：

- `npm run check:release` 已新增并通过：build、190 tests、shell syntax、npm pack dry-run 包边界。
- npm dry-run 确认包名 `clawsense@0.1.0`，21 个文件，不包含 `.codex` / `docs` / `android` / `.local` / `test` / `scripts`。
- Android `assembleDebug` 通过。
- repo-local OpenClaw 命令面复测通过：`status`、`acceptance`、`evidence-video`、`followups`、`acceptance-plan`。
- 当前 repo-local runtime 没有 24h 新事件、没有活跃设备，acceptance 停在 `collecting-data` 是数据状态，不是代码错误。
- Host/Android 只读复审没有剩余 P0/P1；剩余风险是真机 TTS echo drain、背景音拒收和大视频慢速 LAN 上传 30s timeout 压测。
