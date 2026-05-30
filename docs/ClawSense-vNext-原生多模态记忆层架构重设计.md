# ClawSense vNext：原生多模态记忆层架构重设计

## 1. 背景

当前 ClawSense 已经证明：

- Android 端的全天感知采集、分段、上传链路可以成立
- OpenClaw 插件可以完成配对、设备注册、artifact 存储、context/review 输出
- 图片理解在合适配置下可以稳定成功

但当前方案也暴露出一个更根本的问题：

- 我们正在让插件在 ingest 阶段就承担过多“最终理解”职责
- 这会让系统逐步演变成“插件先总结，再交给 OpenClaw 主模型复述”
- 这和产品想要的终局并不一致

产品真正想要的形态，更接近《黑镜》S1E3《The Entire History of You》的体验目标：

- 用户晚上坐下来时，可以直接问 OpenClaw：
  - 今天发生了什么？
  - 有什么值得注意？
  - 今天和谁互动最多？
  - 下午那段讨论主要在说什么？
- 回答者应该是驱动 OpenClaw 的原生多模态主模型
- ClawSense 的职责应当是“提供全天证据与可检索记忆”，而不是“先替主模型想完”

## 2. 核心结论

### 2.1 需要保留的

- 音频 session / segment / boundary / capturedAt
- 图片、视频、音频原始 artifact
- 时间窗、人物、项目、地点、OCR、keyframe 等结构化索引
- transcript、speaker turns、scene boundaries 等中间结果

### 2.2 需要弱化的

- ingest 阶段的事件级 `summary`
- 以插件内部 summary 作为系统主真相
- 把 `visionModel` 或单一 fallback model 当作长期设计中心

### 2.3 需要强化的

- evidence bundle：为主模型提供证据包
- retrieval：按时间、人物、项目、地点、会话检索
- consolidation：由 OpenClaw 主模型后台增量构建“今日记忆图”
- query-time reasoning：由 OpenClaw 主模型对证据做最终理解

## 3. 设计原则

### 3.1 插件不是最终理解者

ClawSense 是感知与记忆层，不是最终回答层。

插件负责：

- capture
- segmentation
- sessionization
- artifact storage
- transcript / OCR / diarization / keyframe
- indexing
- retrieval

OpenClaw 主模型负责：

- 最终理解
- 最终总结
- 最终判断“今天有什么值得注意”

### 3.2 分段不是问题，语义前置才是问题

需要继续保留分段，因为分段服务于：

- 上传与失败重试
- 长时素材的存储
- 检索粒度
- 时间回放
- 计算成本控制

但分段后的结果，不应该自动等价于最终语义结论。

### 3.3 embedding 只做检索增强，不做主理解入口

embedding 的角色应该是：

- transcript chunk retrieval
- OCR / caption retrieval
- people / project / place tag retrieval

embedding 不应成为：

- 原始长音频理解的主要入口
- 最终日总结的主证据

### 3.4 配置要按能力，而不是按厂商默认值

未来配置的中心不应是：

- 默认 `qwen3-omni-flash`
- 默认 `gpt-4.1-mini`

而应是：

- host model 是否支持 image
- host model 是否支持 audio direct understanding
- 是否有 transcription backend
- 是否有 retrieval embedding backend
- 是否支持 video direct reasoning 或仅支持 keyframe reasoning

## 4. vNext 总体架构

## 4.1 Capture Layer

输入：

- 音频
- 图片
- 视频

输出：

- 原始 artifact
- capturedAt / startedAt / endedAt
- session / segment / boundary
- deviceId / people hints / note

这层不做最终语义判断。

## 4.2 Structural Layer

负责把原始素材变成可检索证据：

- VAD / silence segmentation
- speaker diarization
- transcript
- OCR
- keyframe extraction
- scene segmentation
- time-aligned metadata

这层允许“结构化压缩”，但不允许“替主模型下结论”。

## 4.3 Retrieval Layer

负责召回候选证据：

- 时间窗检索
- 会话检索
- 人物检索
- 项目检索
- transcript / caption embedding 检索

这层的产物是 evidence bundle。

## 4.4 Consolidation Layer

负责增量地把全天证据并入“今日记忆图”。

关键点：

- 由 OpenClaw 主模型完成
- 以后台异步任务形式运行
- 不要求一次性读完全天原始媒体
- 但要求逐步建立一天的整体世界模型

输出包括：

- 今日关键事件
- 今日重要人物互动
- 项目进展
- 待跟进事项
- 异常或值得注意的线索

## 4.5 Query-Time Reasoning Layer

当用户提问时：

- ClawSense 提供 evidence bundle
- OpenClaw 主模型读取：
  - 候选 transcript
  - 候选图片
  - 候选视频关键帧或短片段
  - 必要时原始音频/视频片段
- 最终回答“今天发生了什么”“有什么值得注意”

## 5. 为什么这条路线更接近目标

这种架构能同时满足两件事：

### 5.1 保留“原生主模型理解世界”的体验

用户面对的是 OpenClaw 主模型，而不是插件摘要。

### 5.2 避免“一次 prompt 吃全天原始媒体”的工程陷阱

现实里必须解决：

- 上下文窗口
- 费用
- 实时性
- 可检索性
- 可回放性

所以应当由同一个主模型“持续理解全天证据”，而不是每次重新从零读取全天。

## 6. 数据契约重构建议

## 6.1 Event 层

保留：

- `artifact`
- `capturedAt`
- `session`
- `segment`
- `boundary`
- `captureContext`
- `transcript`
- `ocr`
- `speakerTurns`
- `keyframeRefs`

弱化：

- `summary` 作为最终真相的地位

新增建议：

- `evidenceRefs`
- `entityHints`
- `projectHints`
- `locationHints`

## 6.2 Window 层

Window 的职责变成：

- 聚合时间窗
- 聚合 evidence
- 聚合 transcript spans
- 聚合 people/project/entity candidates

而不是：

- 仅仅维护一个 `primarySummary`

## 6.3 Context Tool 层

`clawsense_context` 应从“summary 导出器”转为“evidence bundle 生成器”。

推荐输出：

- `windows`
- `people`
- `projects`
- `entities`
- `topEvidence`
- `rawArtifactRefs`
- `transcriptSpans`

## 7. 配置重构建议

从厂商中心转成能力中心：

- `host_model_audio_mode = direct | transcript-first | none`
- `host_model_video_mode = direct | keyframes | none`
- `host_model_image_mode = direct | caption-first | none`
- `audio_transcription_backend = none | provider_native | speech_api`
- `retrieval_embedding_backend = none | text | multimodal`

保留 provider/model ref，但不内置厂商偏好。

## 8. 阶段性里程碑

### M1

OpenClaw 聊天页可以基于 evidence bundle 回答：

- 今天发生了什么？
- 有什么需要注意？

### M2

系统可以按：

- 时间
- 人物
- 项目
- transcript 片段

召回今天的候选证据。

### M3

后台 consolidation 建立“今日记忆图”：

- 今日事件
- 今日人物互动
- 待跟进事项
- 风险与注意点

### M4

完成开源用户可移植配置：

- 不再依赖某个默认厂商模型
- 文档按能力组织

## 9. 对当前方案的判定

当前方案不是完全错误，但它更像 v0：

- 可以做全天采集
- 可以做基础 context/review
- 但还没有把“最终理解权”真正交给 OpenClaw 主模型

vNext 的目标，是把 ClawSense 从“多模态分析插件”升级成“原生多模态记忆层”。
