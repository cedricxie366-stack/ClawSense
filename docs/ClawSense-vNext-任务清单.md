# ClawSense vNext 任务清单

## 目标

把 ClawSense 从“ingest 阶段就产出最终 summary 的插件”，改成“为 OpenClaw 主模型提供全天 evidence 的记忆层”。

## 当前进展快照（2026-05-30）

### 产品主线调整

当前 vNext 的近期主线调整为：

> **先把 ClawSense 做成 OpenClaw 的现实世界语音对话入口，再继续推进视频和更强识别能力。**

当前 worktree 已进入交付收口整理：后续先按 [当前阶段交付收口清单](./当前阶段交付收口清单.md) 和 [当前阶段分批提交计划](./当前阶段分批提交计划.md) 将 Host evidence runtime、Android realtime voice client、测试矩阵、文档验收、安装发布五组分批 review 和提交，再进入 Android 视频 M2 的新依赖/录制策略决策。

Phase 8 的代码闭环已先按通过处理，真实长对话素材由验收线程逐步补齐；主开发线重新推进视频 M1 和证据质量增强。短期仍以语音对话入口成立为产品闭环，但不再让长对话验证阻塞视频证据链建设。

- 手机端语音提问
- 服务端 evidence 检索
- OpenClaw 主模型回答
- 手机 TTS 播报
- 屏幕完整答案展示
- 连续追问和沉淀文件意图

视频、OCR、speaker diarization、全天向量化仍然重要，但它们是 evidence 质量增强，不是当前产品闭环的第一阻塞。

### 已完成 / 进行中

- Phase 1（evidence bundle 契约）：已完成并稳定使用
  - context/evidence 输出、artifact refs、窗口化结构均已上线
- Phase 3（retrieval 层）：已完成基础能力并投入使用
  - 时间窗与人物/项目线索检索可用，音频补强与回填链可用
- Phase 4（上下文工具重构）：已完成并默认 evidence-first
  - 聊天页与工具输出已以 evidence 为主，不再依赖弱 summary
- Phase 5（主模型 consolidation）：已完成首版并持续加固
  - 日级 consolidation 生成与缓存复用已上线，质量持续优化中
- Phase 6（配置标准化）：收口中（接近完成）
  - 多 provider fallback 技术债已收口
  - capability 配置项（audio/image/video/retrieval）已对齐并补齐回归测试
  - `acceptance-plan` 已上线，用于可执行验收闭环
- Phase 7（验收矩阵）：进行中（主要阻塞项）
  - CLI 验收能力已可跑：`acceptance` / `acceptance-plan` / `doctor`
  - 真实素材覆盖与连续多天验证仍是主阻塞
- Phase 2（结构化层）：视频子项已进入 M1（关键帧结构化与片段关联）阶段
  - `/api/clawsense/ingest/video` 已可入队/入库（受 `hostModelVideoMode` 开关控制）
  - `keyframes` 模式：视频原片保留 + 可选关键帧入队，视频事件仍以 metadata/degraded 方式落库
  - `direct` 模式：会先尝试主模型原生视频理解，失败再回退 metadata/degraded，不阻塞上传链路
  - 已支持 `keyframes[]` 随视频上传并作为图片证据入队（M1 的结构化入口已预埋）
  - evidence bundle 已支持 `videoRequestId` 聚合输出（同次视频+关键帧证据组），聊天页可直接引用
  - review-engine 已改为 audio/image/video 三类窗口计数，视频不再混入图片统计
  - 关键帧 evidence 已结构化输出 `caption`、`ocrHints`、`linkedVideo...` 片段回链
  - 当前补强：支持从关键帧 note marker 读取结构化 `caption` / `ocr` / `videoOffsetMs`，并用片段内 offset 稳定回链原始视频
  - `/api/clawsense/ingest/video` 已支持在 `keyframes[]` item 中附带 `caption` / `ocrHints` / `ocrText` / `videoOffsetMs`，服务端会写入稳定 marker
  - 下一步：进入 Android 视频 M2 前，需要决定是否引入 CameraX VideoCapture（`androidx.camera:camera-video`）以及录制策略（短片段时长、触发方式、上传频率、隐私提示）
- Phase 8（语音 Agent 对话层）：代码闭环已收口，真实素材验收继续并行
  - 显式提问、时间范围解析、日级回顾、TTS 摘要已接入
  - `/api/clawsense/assistant/query` 开始支持“模型回答 + 模板兜底”
  - 已支持上一轮 `previousTurn`、`继续说 / 简短点 / 读全文 / 停止朗读` 的模板兜底承接
  - 已支持 `draft_document` action，并可在服务端生成 markdown 草稿文件
  - Android 已支持朗读中主动停止本地 TTS
  - 下一步：由验收线程补真实长对话、真实 TTS 体验和草稿文件 UI/聊天页可见性，不阻塞主线继续开发

## 工作流原则

- 不再继续扩大插件内 summary 的职责
- 优先建设 evidence bundle、retrieval、consolidation
- 配置按能力设计，不按厂商默认模型设计

## Phase 0：止血与共识

### 任务

- 把现有 ingest `summary` 明确降级为 fallback 文案
- 明确 `event.summary` 不是主事实来源
- 补文档说明 ClawSense 是 memory/evidence layer

### 产出

- 文档说明更新
- 代码注释和 tool 描述更新

### 验收

- 聊天页回答逻辑不再默认依赖 `event.summary`

## Phase 1：evidence bundle 契约

### 任务

- 定义 evidence bundle schema
- 定义 event/window/evidence 的边界
- 为 audio/image/video 统一 artifact ref 与 evidence ref 结构

### 产出

- 新 schema 文档
- TypeScript 类型

### 验收

- 任意时间窗都能导出标准 evidence bundle

## Phase 2：结构化层

### 任务

- 音频：保留 session / segment / boundary / transcript / speaker turn
- 图片：OCR + 基础 caption
- 视频：keyframe + short clip + OCR
- 建立 transcript spans 与 keyframes 对齐关系

### 产出

- audio structural pipeline
- image structural pipeline
- video structural pipeline（M0 已入库，M1 已具备 keyframe/clip 结构化证据，继续补真实采集端 offset/OCR 写入）

### 验收

- 可根据一个 session 找到其 transcript、图片、关键帧与短片段

## Phase 3：retrieval 层

### 任务

- 时间检索
- 人物检索
- 项目检索
- transcript/caption embedding 检索
- evidence ranking

### 产出

- retrieval service
- retrieval ranking rules

### 验收

- 给定问题，能召回合理的候选 evidence windows

## Phase 4：上下文工具重构

### 任务

- `clawsense_context` 从 summary 工具改成 evidence tool
- 输出：
  - windows
  - people
  - projects
  - topEvidence
  - transcript spans
  - artifact refs

### 产出

- tool schema 更新
- skill 文档更新

### 验收

- 聊天页可以直接基于 evidence bundle 回答“今天发生了什么”

## Phase 5：主模型 consolidation

### 任务

- 增量 consolidation job
- 让 OpenClaw 主模型把新 evidence 并入今日记忆图
- 抽取：
  - 关键事件
  - 人物互动
  - 项目进展
  - 待跟进事项

### 产出

- consolidation pipeline
- today-memory graph

### 验收

- 一天结束时可直接产出高质量“今日值得注意事项”

## Phase 6：配置标准化

### 任务

- 新增 capability-based config
- 保留 provider/model ref
- 去掉默认厂商偏置

### 推荐配置项

- `host_model_audio_mode`
- `host_model_image_mode`
- `host_model_video_mode`
- `audio_transcription_backend`
- `retrieval_embedding_backend`

### 验收

- OpenAI / Gemini / Qwen / 其他 OpenAI-compatible 部署都能接

## Phase 7：验收矩阵

### 任务

- 干净 OpenClaw 环境安装验收
- 图片-only 验收
- 音频 + transcript-first 验收
- 视频 + keyframe 验收
- 聊天页问答验收

### 关键问题

- 今天发生了什么？
- 有什么需要注意？
- 今天和谁互动最多？
- 下午那段讨论主要在说什么？

### 验收

- 回答基于 evidence，可回链到原始素材

## Phase 8：语音 Agent 对话层（当前第一优先级）

### 目标

让 ClawSense Android 客户端成为 OpenClaw 的现实世界语音入口：

- 手机负责显式语音提问、TTS 播报和答案展示
- ClawSense 负责检索最近 / 过去 N 小时 / 今天 / 昨天 evidence
- OpenClaw 主模型负责自然语言理解、推理、建议和可沉淀输出
- 本地模板只做稳定兜底

### 任务

- Assistant query 从固定模板升级为：
  - evidence 检索
  - 大模型回答
  - 模板兜底
- 支持自然追问：
  - `继续说`
  - `详细说说第二点`
  - `简短点`
  - `读全文`
  - `停止朗读`
- 支持可执行意图：
  - `帮我整理成会议纪要`
  - `把行动项沉淀成文件`
  - `生成学习笔记`
- 支持对话上下文：
  - 上一轮问题
  - 上一轮 evidence 范围
  - 上一轮 answer/actionIntent

### 产出

- `assistant/query` 模型回答链路
- assistant session state（首版：按 deviceId 保留上一轮）
- spoken/text 双通道答案策略（首版：摘要播报 + `读全文` 长播报）
- document draft action schema（首版：生成 markdown 草稿）

### 验收

用户可以连续语音对话：

- `过去4小时我们聊了什么？`
- `你怎么看？`
- `详细说说数据看板那段。`
- `帮我整理成会议纪要。`
- `读全文。`

系统必须：

- 选对时间范围
- 引用音频和画面证据
- 由大模型生成自然回答
- 失败时回退模板
- 不伪造文件创建结果

## 优先级建议

### 第一优先

- Phase 8
- Phase 3
- Phase 4

### 第二优先

- Phase 2
- Phase 5

### 第三优先

- Phase 6
- Phase 7

## 建议的实际开工顺序

1. 已完成首版：把 `assistant/query` 接成“evidence + 大模型 + 模板兜底”
2. 已完成首版：连续追问、`读全文 / 简短点 / 继续说` 模板承接
3. 已完成首版：`draft_document` action intent 与 markdown 草稿落地
4. 下一步：真机语音验收和草稿文件 UI/聊天页可见性
5. 再补 transcript / OCR / keyframe 检索
6. 再进入视频 M1 和全天记忆向量化增强

## 里程碑

### M1

聊天页基于 evidence bundle 回答“今天发生了什么”

### M2

可按人物/项目/时间检索全天素材

### M3

主模型具备今日记忆图增量更新能力

### M4

完成开源能力导向配置与文档更新

### M5

手机端成为可用的 OpenClaw 现实世界语音入口：能问、能答、能追问、能播报、能提出可沉淀文件动作。
