# ClawSense vNext 任务清单

## 目标

把 ClawSense 从“ingest 阶段就产出最终 summary 的插件”，改成“为 OpenClaw 主模型提供全天 evidence 的记忆层”。

## 当前进展快照（2026-07-14）

### 产品主线调整

当前 vNext 的近期主线调整为：

> **先把 ClawSense 做成 OpenClaw 的现实世界语音对话入口，再继续推进视频和更强识别能力。**

当前 worktree 已进入交付收口整理：Host evidence runtime、Android realtime voice client、测试矩阵、文档验收、安装发布五组已完成分批计划，但尚未执行正式 `git add` / `git commit`；Android Video M2 也已先按“手动 6 秒短视频 + 关键帧”完成最小闭环。下一步不再讨论“是否进入 M2”，而是收口手动短视频体验、验证可访问 Host + `hostModelVideoMode=keyframes` 下的真机入库，再决定是否进入自动/连续视频。

2026-06-02 新增融合判断：

- `ingest_queue_full` 不是孤立 bug，而是全天采集、实时语音助手、自动视频共同依赖的数据面可靠性问题。
- 自动录视频不是视频 M2 的简单按钮增强，而是“关键时刻 evidence 增强”的下一阶段能力。
- 因此 Phase 9 已并入当前收口：先以 `fast ingest + async analysis + queue-status` 稳住数据面，再把语音 / 文字 / OCR 触发视频做成默认关闭、低频、可解释、受队列和上限保护的短视频 evidence 增强。

Phase 8 的代码闭环已先按通过处理，真实长对话素材由验收线程逐步补齐；主开发线已完成视频 M1 evidence 链，并把 Android Video M2 收窄为手动 6 秒短视频验证块。短期仍以语音对话入口成立为产品闭环，但不再让长对话验证阻塞视频证据链建设。

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
  - rolling digest 已可沉淀为长期 `memoryCards`（任务 / 话题 / 注意 / 学习点），并通过 CLI 与 `responseHints` 暴露，作为后续 transcript/caption embedding 的对象层
  - `memoryCards` 已可输出 Markdown 报告并写入 drafts 目录，形成“证据 -> 记忆卡片 -> 可保存文档草稿”的非真机闭环
  - embedding 前召回排序已具备可解释输出：`memoryCardMatches` 包含 `retrievalRank`、`score`、`matchedTerms`、`matchReasons`，用于在未配置向量库时稳定回答任务/风险/学习/文档类问题
  - 记忆卡片语义去重 / 证据归并已具备存储层保障：同一日期、scope、类型和标题的卡片会合并证据链，避免多次 rolling digest 后重复膨胀
  - 人物 / 项目历史追问已接入长期记忆卡片：历史对象会携带相关任务卡 / 话题卡，并在 `clawsense_context` 中展示“关联记忆卡片”
  - `openclaw clawsense history` 已作为人物 / 项目历史记忆 CLI 观测入口，便于验收线程检查历史项、关联卡片和继续追问目标
  - 办公业务主线抽取已增强：`AI 陪练 / 语料同步 / 考核规则 / 报告优化 / 培训安排` 会成为稳定 `projectRefs`；旧历史 state 可用 `openclaw clawsense refresh-semantics [date]` dry-run / `--apply` 迁移语义索引
  - 项目历史追问已补齐中文别名和证据质量排序：自然语言问“AI 陪练这个项目之前出现过什么”时，优先返回可读 transcript / 音频证据，再带关联 `memoryCards`
  - speaker 标注辅助已从“缺身份提示”升级为“任务归属影响面提示”：`speaker-slots` 会输出 `slotTaskImpacts`、候选标注命令和 `requiresDiarization`，明确哪些任务只能靠窗口上下文暂时推断，哪些仍需要句子级 speaker 才能精确归属
- Phase 4（上下文工具重构）：已完成并默认 evidence-first
  - 聊天页与工具输出已以 evidence 为主，不再依赖弱 summary
  - `audioDiagnostics` 已进入 evidence bundle / `responseHints`：OpenClaw 主模型能知道 raw audio 当前是 `available`、`deleted` 还是缺 artifact record，避免把 retention 删除误判成“模型没听音频”
  - context/evidence 只暴露 `artifact.available=true` 的原始音频引用；raw audio 已删除时改为明确给出 blocker 和 next actions
- Phase 5（主模型 consolidation）：已完成首版并持续加固
  - 日级 consolidation 生成与缓存复用已上线，质量持续优化中
- Phase 6（配置标准化）：收口中（接近完成）
  - 多 provider fallback 技术债已收口
  - capability 配置项（audio/image/video/retrieval）已对齐并补齐回归测试
  - `acceptance-plan` 已上线，用于可执行验收闭环
- Phase 7（验收矩阵）：Host / fixture 已 ready-to-close，最终仍等物理 Android live
  - CLI 验收能力已可跑：`acceptance` / `acceptance-plan` / `doctor`
  - `npm run check:non-device-product-gate` 已成为非真机产品质量门禁：覆盖 Evidence v2 synthetic 正向音频诊断、conversation routing 公开 AMI 对话包、6 月 25 日真实历史 retention 边界、公开 AMI/中文会议 replay、active raw audio positive、speaker slots 和自动视频 fixture
  - `npm run report:non-device-product-gate` 已可只读最近一次 `.local/non-device-product-gate-reports/latest.json` 摘要，方便主开发线程 / 验收线程快速复查关键字段而不重跑完整门禁；当前 `freshness.isStale=false`
  - 当前非真机 gate 最新通过指标：`passed=9`、`skipped=0`、`failed=0`，报告为 `.local/non-device-product-gate-reports/non-device-product-gate-2026-07-13T17-25-48-127Z.json`；`evidence-v2-synthetic` 和 `conversation-routing` 均显示 `rawAudioArtifacts=available`、`audioBlockerIds=["audio-ready"]`；`historical-real-state` 显示 `contextAudioMatchesDiagnostics=true` 且 raw audio retention 删除被正确标成 `raw-audio-retention-deleted`
  - `CHECK_ANDROID=0 npm run check:release` 已接入轻量 `check:evidence-v2`，发布边界会实际验证长音频 topic、speaker timeline、任务归属和 audioDiagnostics 正向路径；最新运行通过，`274` tests passed
  - 公开 fixture 覆盖已补齐 AMI 办公会议 + MIT 课堂 transcript + MIT 课堂视频；当前 repo-local acceptance 已达到 `5/5`、`100%`、`ready-to-close`
  - 公开 AMI 办公会议 replay 已进入 `check:phase`：阶段门禁会把公开 AMI hybrid ASR 结果写入当天日期，并验证 transcript spans、topic segments、followups 和 `speaker_2 -> Sarah` 标注复用
  - 公开 AliMeeting 中文会议已补齐 optional host-side 验证：metadata smoke、120 秒远场切片、FunASR-primary + CAM++ 深测，以及 `check:public-zh-replay` 写入 ClawSense context/followups/speaker annotation 链路
  - 视频验收已不再只靠 `hostModelVideoMode=none` 跳过：`keyframes` 模式下公开视频 fixture 可提供 1 个真实 MP4、3 个关键帧、3 条同 `videoRequestId` 的 transcript spans
  - `npm run check:phase` 已作为当前阶段一键门禁，覆盖 release gate、公开视频 replay、speaker annotation smoke、acceptance、video evidence 与 Phase 9 断言；当私有 AMI fixture 缺失时，会用公开 AMI replay 兜住办公会议场景
  - `check:stage-final` / `check:stage-final:doctor` 已新增为最终阶段门禁：必须同时拥有 fresh primary Android live report 和 fresh no-arm ambient report；当前只读 doctor 状态为 `primary-live-stale`
  - 截至 2026-07-03 17:30，最新 phase report `.local/current-phase-reports/current-phase-20260703-173031.json` 已为 `ok=true`，`phaseState=ready-to-close`，并包含 Phase 9 汇总 `autoVideoTriggerChecks=4`、`hostChecks=7`、`androidChecks=11`、`liveReportChecks=5`
  - 同一报告中的公开 AMI replay 指标为：`segmentCount=36`、`transcriptSpans=12`、`topicSegments=10`、`evidenceFollowUpTargets=8`、`annotatedSpeaker=Sarah`
  - AliMeeting 中文 replay 指标为：`segmentCount=7`、`transcriptSpanCount=7`、`topicSegmentCount=1`、`evidenceFollowUpTargetCount=2`、`annotatedSpeaker=同事A`；这条不进入默认 phase gate，但作为中文办公会议 ASR / speaker 回归入口保留
  - 自动视频验收已从 primary live 中独立出来：正向自动视频报告必须用 `EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect` 生成；如果本阶段把主动视频也作为发布硬门槛，再用 `REQUIRE_AUTO_VIDEO_LIVE=1 npm run check:stage-final` 要求第三份 fresh auto-video live 证据
  - 真实 Android 采集、TTS 体验、手动短视频入库和 no-arm 环境音不污染验收仍是主阻塞；`check:android-live:doctor` 当前为 `waiting-for-device`，唯一 blocker 是 `no authorized Android device connected`
- Phase 2（结构化层）：视频子项已进入 M2 手动短视频收口
  - `/api/clawsense/ingest/video` 已可入队/入库（受 `hostModelVideoMode` 开关控制）
  - `keyframes` 模式：视频原片保留 + 可选关键帧入队，视频事件仍以 metadata/degraded 方式落库
  - `direct` 模式：会先尝试主模型原生视频理解，失败再回退 metadata/degraded，不阻塞上传链路
  - 已支持 `keyframes[]` 随视频上传并作为图片证据入队（M1 的结构化入口已预埋）
  - evidence bundle 已支持 `videoRequestId` 聚合输出（同次视频+关键帧证据组），聊天页可直接引用
  - review-engine 已改为 audio/image/video 三类窗口计数，视频不再混入图片统计
  - 关键帧 evidence 已结构化输出 `caption`、`ocrHints`、`linkedVideo...` 片段回链
  - 当前补强：支持从关键帧 note marker 读取结构化 `caption` / `ocr` / `videoOffsetMs`，并用片段内 offset 稳定回链原始视频
  - `modality=video` 的 context/evidence 会包含同一 `videoRequestId` 下的音频 transcript，避免视频问答只看关键帧画面
  - `/api/clawsense/ingest/video` 已支持在 `keyframes[]` item 中附带 `caption` / `ocrHints` / `ocrText` / `videoOffsetMs`，服务端会写入稳定 marker
  - Android 端已引入 CameraX VideoCapture（`androidx.camera:camera-video`），当前策略固定为手动 6 秒 video-only MP4
  - Android 上传会附带起止关键帧，UI 会显示录制中 / 上传中 / 成功 / 失败状态
  - 下一步：手动短视频继续作为可验收基线；自动视频进入 Phase 9，但必须依赖数据面背压、冷却时间、触发原因记录和队列状态，不再作为独立孤岛需求处理
- Phase 8（语音 Agent 对话层）：代码闭环已收口，真实素材验收继续并行
  - 显式提问、时间范围解析、日级回顾、TTS 摘要已接入
  - `/api/clawsense/assistant/query` 开始支持“模型回答 + 模板兜底”
  - 已支持上一轮 `previousTurn`、`继续说 / 简短点 / 读全文 / 停止朗读` 的模板兜底承接
  - 已支持 `draft_document` action，并可在服务端生成 markdown 草稿文件
  - 宽时间窗问题（`过去4小时 / 今天 / 昨天`）已扩大 assistant context 取样，不再被最近 6 个窗口截断
  - 讨论 / 会议 / 访谈视频类问题已优先排序音频 transcript evidence，避免回答只看最近图片
  - 最终真机门禁已加入 no-arm ambient clean 报告要求：播放访谈/视频但不点击问实时助手时，不得产生 assistant query 日志
  - Android 已支持朗读中主动停止本地 TTS
  - 下一步：由验收线程补真实 primary live report 和 no-arm ambient report；在 `npm run check:stage-final` 通过前，不再把当前阶段标记为完成

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
- speaker 标注影响面：`slotTaskImpacts` 将未归属任务、候选 speaker slot 和可复制标注命令连起来，并明确 `window-context-only` 与 `exact-speaker-label` 的差异

### 验收

- 给定问题，能召回合理的候选 evidence windows
- 当用户问“哪些任务分配给我”但 speaker 未标注时，系统不能硬判归属；应给出需要标注的 speaker slot、受影响任务样例和是否仍需要 diarization

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

## Phase 9：数据面可靠性与主动视频触发（当前融合层）

### 定位

Phase 9 不是替代 Phase 8，而是让 Phase 8 在真实全天使用里不崩的地基，同时也是从“手动短视频”进入“主动视频 evidence 增强”的入口。

它在整体路线里的位置固定为：

- 承接 Phase 8：实时语音对话要依赖稳定 evidence，而不是依赖同步分析是否刚好完成。
- 加固 Phase 2：视频能力从“手动短视频”升级到“关键时刻短视频 evidence”，但不进入连续录像。
- 铺垫长期全天记忆：先保住原始 artifact 与 pending evidence，再让 transcript、caption、OCR、speaker 异步补齐。

它解决两个问题：

1. 服务端不能因为 ASR / 多模态分析慢而阻塞上传。
2. 手机端不能只靠手动按钮录视频，而要能在关键语音 / 文本 / 画面信号出现时低频、可解释地补录短片段。

### 任务 A：fast ingest + async analysis

状态（2026-06-02）：最小闭环已落地。

- 上传请求只做：
  - 设备鉴权
  - artifact 保存
  - pending event / window 创建
  - 返回 `202`
- 后台 `analysisQueue` 再做：
  - runtime STT
  - provider ASR
  - multimodal audio/image/video
  - OCR / caption
  - late recheck
- `ingestQueue` 和 `analysisQueue` 拆分，避免一个 2-3 分钟的音频分析拖住图片和视频。
- 对低信号音频直接 `pending/low_signal`，不在高压时逐条同步尝试全部 fallback。
- 已实现：
  - 音频 / 图片 / 视频上传先创建 `analysis_pending` evidence 与 artifact，再返回 `202`。
  - 后台 `analysisQueue` 负责补跑 ASR / 多模态分析并回填 `analysisMode`、`analysisProvider`、`analysisStatus`、summary 和 transcript。
  - `analysis_pending` 自动恢复器每分钟补排未进入队列的 artifact，避免极端拥堵后永久挂起。

### 任务 B：queue-status 与背压节流

状态（2026-06-02）：服务端状态面、Android ACK 与第一版端侧自适应节流已落地；仍需真机高压验证和阈值调优。

- 新增 CLI / HTTP 状态面：
  - ingest queue depth
  - analysis queue depth
  - pump active
  - oldest queued age
  - recent timeout count
  - recent 503 count
  - current processing modality
- Android 区分：
  - 网络失败
  - 鉴权失败
  - 服务端分析拥堵
- Android 在拥堵时自适应：
  - 降低图片频率
  - 合并或延后低信号音频
  - 暂停自动视频触发
  - 待队列恢复后再补传
- 已实现：
  - `/api/clawsense/queue/status` 与 `openclaw clawsense queue-status`。
  - `openclaw clawsense analysis-retry` 可手动补排 pending artifact。
  - Android 上传 ACK 已能承载 `stored`、`analysisQueued`、`analysisQueueDepth`，并在首页显示“后台分析队列”状态。
  - Android 已新增统一 `CaptureThrottleSnapshot`：根据 503 backpressure、`analysisQueued=false`、analysis queue depth 和待补传压力计算 `NORMAL / ELEVATED / SEVERE`。
  - `ELEVATED` 时拉长图片采样间隔；`SEVERE` 时跳过本轮图片、延后低信号音频进入补传队列，并暂停自动视频 directive。
  - Android live report 已能汇总 `stillCaptureDeferred`、`lowSignalAudioDeferred`、`autoVideoThrottled` 等节流信号。
  - Debug APK 已提供 `scripts/check-android-live.sh inject-throttle <duration_ms> <queue_depth>`，用于在真实拥堵难复现时验证端侧节流和报告汇总器；它不能替代真实服务端拥堵压测。

### 任务 C：主动视频触发 MVP

状态（2026-06-02）：最小闭环已落地；已补用户开关、运行期上限和 fixture 门禁，仍需真机验收与更细触发规则。

- 触发来源：
  - 显式语音命令：`录一下这个`、`帮我看一下这段`、`这段很重要`
  - transcript 意图：会议 / 访谈 / 演示里出现“看这里 / 这个图 / 这页 PPT / 重点是”
  - OCR/caption：画面出现演示、白板、PPT、代码、表格、视频字幕等高信息密度内容
- 触发保护：
  - 服务端 queue-status 不拥堵
  - Android 当前不在 assistant query / TTS / 视频录制中
  - 设备有相机权限且服务运行
  - 冷却时间、小时上限、每日上限
  - 用户可关闭自动视频
- 录制策略：
  - 首版仍为 6 秒短视频
  - 上传时带起止关键帧
  - note 写入 `auto-video-trigger`、`triggerReason`、`triggerSource`、`sourceEventId`、`sourceText`
- 已实现：
  - Host 在后台分析完成后，根据 transcript / summary 里的显式录制、视觉指代、高信息密度信号生成一次性 `video_clip` directive。
  - directive 通过设备 heartbeat 下发，带 `directiveId`、`durationMs`、`reason`、`sourceEventId`、`sourceText`、`expiresAt`。
  - Android 默认关闭自动视频；用户在首页显式打开后才会响应 directive。
  - Android 收到 directive 后检查相机运行状态、助手/TTS 状态、最近队列 ACK、10 分钟冷却、每小时 2 段和每天 8 段上限，再自动录制 6 秒视频并上传。
  - 自动视频 note 会写入 `auto-video-trigger`、`triggerReason`、`triggerSource=heartbeat-directive`、`sourceEventId`、`sourceText`。
  - Host 只向前台服务心跳 `appState=service...` 下发 directive，避免 WorkManager 后台心跳误领后丢失。
  - `npm run check:phase9` 已覆盖 4 个触发规则、7 个 Host invariant、11 个 Android invariant 和 5 个 live-report invariant，并已接入 `check:release` / `check:phase`。
  - `EXPECT_AUTO_VIDEO=1` live report 已独立于 primary live；自动视频成功只能证明 Phase 9C evidence 增强，不能替代语音问答 / TTS 的 primary live 证据，也不能替代 no-arm ambient clean 证据。

### 暂不做

- 全天连续录像。
- 长视频自动切片。
- 端侧环形视频 pre-buffer。
- 自动替用户决定长期保存隐私敏感视频。

这些能力只有在 fast ingest、队列状态、隐私提示和真实办公试用稳定后再评估。

### 验收

- 高频音频 + 图片上传时，服务端不应频繁返回 `503 ingest_queue_full`。
- 即便 analysisQueue 堆积，`media-today` 也能看到 pending 事件和 artifact 先入库。
- Android UI 能把“服务端拥堵，稍后补传”和“网络不可达 / 401 重配”区分开。
- 真实拥堵难稳定复现时，可以先用 debug-only throttle injection 验证端侧降频 / 延后 / 暂停自动视频逻辑，但最终报告必须标注 `queue throttle source=debug-injection`，不能把它当成真实服务器压测通过。
- 播放访谈 / 会议素材时，出现显式触发语义后，Android 能自动录制一段 6 秒视频并上传。
- 自动视频 evidence 能回答：
  - 为什么录了这段？
  - 这段关联了哪句话 / 哪张图 / 哪个 OCR 线索？
  - 这段视频里有什么值得回看？

## 优先级建议

### 第一优先

- Phase 9 真机验收与阈值调优（数据面可靠性子项优先于主动视频子项）
- Phase 8
- Phase 3
- Phase 4

### 第二优先

- Phase 2（手动短视频继续作为基线；自动短视频已归入 Phase 9，连续视频另行决策）
- Phase 5

### 第三优先

- Phase 6
- Phase 7

## 建议的实际开工顺序

1. 已完成首版：把 `assistant/query` 接成“evidence + 大模型 + 模板兜底”
2. 已完成首版：连续追问、`读全文 / 简短点 / 继续说` 模板承接
3. 已完成首版：`draft_document` action intent 与 markdown 草稿落地
4. 已完成公开素材 fixture 收口：AMI 办公会议 + MIT 课堂 replay / rubric / speaker annotation smoke，repo-local acceptance `ready-to-close`
5. 已完成中文公开会议 host-side 回归：AliMeeting metadata / FunASR-primary 深测 / ClawSense replay / speaker 标注复用
6. 已完成当前阶段一键门禁：`npm run check:phase`
7. 已完成 Phase 9A/B 最小闭环：fast ingest、async analysis、queue-status、analysis-retry、Android 上传 ACK / 队列状态展示
8. 已完成 Phase 9C 最小闭环：Host 下发一次性 `video_clip` directive，Android 用户开启后低频自动录制 6 秒视频并写入触发原因
9. 已完成 Phase 9 机器门禁：`npm run check:phase9` 覆盖触发规则、Host / Android invariant 和 live report 汇总字段，并已接入 release / phase gate；live report 现在能区分 primary / no-arm / auto-video 三类证据
10. 下一步：真机验证 Phase 9C 默认关闭、开启后触发、note metadata、冷却 / 上限和 Host evidence 回答；正向自动视频报告必须用 `EXPECT_AUTO_VIDEO=1` 生成，严格最终门禁用 `REQUIRE_AUTO_VIDEO_LIVE=1`
11. 真机验证并调优 Android 自适应节流：拥堵时降低图片频率、延后低信号音频、暂停自动视频
12. 最后再决定是否进入连续视频、端侧 pre-buffer 和全天记忆向量化增强

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

### M6

数据面进入全天试用形态：上传先稳定落库，分析异步补齐，拥堵可观测，Android 可节流。

### M7

主动视频 evidence 增强成立：系统能根据语音 / 文字 / OCR 信号低频触发短视频，并把触发原因回链到 evidence。
