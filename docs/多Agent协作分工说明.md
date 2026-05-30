# ClawSense 多 Agent 协作分工说明

这份说明用于把 ClawSense 从“单 agent 串行推进”切到“多 agent 并行推进”。

目标不是把项目拆碎，而是：

- 保持共享契约稳定
- 让 Android、后端、回顾体验三条线并行
- 降低上下文切换成本
- 让总架构和最终集成保持统一

## 0. 当前节点共识

在进入多 agent 协作之前，当前全项目口径要先统一：

- `Phase 1` 已经初步完成
  - Android 与 OpenClaw 主机端可联通
  - 音频上传可用
  - 图片上传可用
  - 项目已上 GitHub 与 npm
- `Round-4 P0` 已经完成真实收口
  - 图片主多模态分析已在真实环境中成功
  - 音频在 `runtime STT` 空结果后已能给出保守语义
  - `csAudio:v2` 会话线索已被后端真正消费
- 当前主推进方向是：
  - “普通聊天页接入 + 最小标注闭环 + 开源部署标准化”
- 媒体库访问约束是：
  - 默认复用用户当前访问 OpenClaw 的同一地址
  - 不要求用户配置域名或反向代理
  - 不依赖 ClawSense 官方公网域名
  - 最终目标是同 host、同 origin 的独立轻量页，不耦合 Control UI 壳
- 官方协议相关的结论是：
  - 后续会考虑**官方控制面兼容**
  - 当前不会把已跑通的 ClawSense ingest 数据面替换成官方 Android Companion / node 协议
  - 未来目标是“官方控制面兼容 + ClawSense 数据面保留”的混合架构

这条共识对所有 agent 都成立，不允许各自改写。

## 1. 当前判断

当前仓库已经不再是单一 MVP：

- 有 Android 采集端
- 有 OpenClaw 插件后端
- 有媒体库 / Daily Review / Skill 体验层

继续单 agent 做不是不行，但效率会被下面 3 件事拖慢：

- 频繁在 Android / backend / UX 间切换
- 不同工作流的验证方式完全不同
- 现在已经具备清晰的模块边界，可以并行

所以当前阶段推荐结构是：

- `1` 个统筹 agent
- `3` 个执行 agent

不建议再往下细拆成 5 到 6 个小 agent，否则会很快进入“接口打架”和“上下文重复灌输”的阶段。

## 2. 角色结构

### A. 统筹 Agent

职责：

- 负责产品方向、架构边界、数据模型和 API 契约
- 负责跨 agent 合并顺序
- 负责验收标准
- 负责发布与文档总线

统筹 agent 默认拥有最终拍板权，尤其针对：

- 共享数据结构
- HTTP 接口
- Android 与 backend 的协议
- `DailyReview` 输出结构

### B. Android / Sensor Agent

职责：

- Android 前台服务
- 音频 VAD
- CameraX 采集
- 上传稳定性
- 权限状态与服务状态反馈
- 电量 / 机型兼容 / 后台恢复

### C. Backend / Event Intelligence Agent

职责：

- `RawArtifact`
- `CaptureEvent`
- `PersonAnnotation`
- `DailyReview`
- STT fallback
- retention
- 事件窗口
- 回顾生成引擎

### D. Product Surface / Review Experience Agent

职责：

- 轻量媒体库页面
- Daily Review Skill
- Review 输出结构
- 人物标注交互
- 面向用户的 README / Guide / Demo 路线

媒体库相关的产品硬约束：

- 主入口默认就是用户当前 OpenClaw 所在地址
- 不能把“自定义域名 / 反代配置”当成默认前提
- 不能把 ClawSense 官方域名当成媒体查看入口
- 不能把 Control UI 聊天页壳子当成最终浏览体验

## 3. 所有 Agent 共用的项目背景

所有 agent 共享以下统一背景，不要每个人自行改写：

- 项目名：`ClawSense`
- 定位：把旧 Android 手机变成 OpenClaw 的可穿戴感知节点
- 当前阶段：Round-4 已收口，下一步围绕“产品闭环 + 开源部署标准化”推进
- 推荐运行环境：**由原生多模态大模型驱动的 OpenClaw**
- 核心路线：
  - 多模态模型是主分析引擎
  - 事件索引层先整理素材
  - `runtime STT` 只做兜底
  - 官方控制面兼容是后续方向，当前数据面仍以 ClawSense 自己的 ingest 路径为主
- 本阶段明确不做：
  - 视频采集
  - 语音开启视频
  - 微表情自动结论
  - 重型固定 Web 回顾页

## 4. 共享契约文件

下面这些文件是“共享契约层”。执行 agent 不应随意改动；如确实要改，先提交提议给统筹 agent。

- `/Users/cedric/Documents/ClawSense/index.ts`
- `/Users/cedric/Documents/ClawSense/src/state-store.ts`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/DeviceModels.kt`

如果需要改这些文件，建议走这个流程：

1. 先提出变更原因
2. 给出最小差异
3. 说明对其他 agent 的影响
4. 由统筹 agent 决定是否并入

## 5. 各 Agent 可编辑范围

### Android / Sensor Agent 可优先编辑

- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/MainActivity.kt`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/MainViewModel.kt`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/DeviceSessionRepository.kt`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/OkHttpClawSenseApi.kt`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/sensors/*`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/*`
- `/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/work/*`

### Backend / Event Intelligence Agent 可优先编辑

- `/Users/cedric/Documents/ClawSense/src/config.ts`
- `/Users/cedric/Documents/ClawSense/src/http.ts`
- `/Users/cedric/Documents/ClawSense/src/memory-store.ts`
- `/Users/cedric/Documents/ClawSense/src/openai-client.ts`
- `/Users/cedric/Documents/ClawSense/src/review-engine.ts`
- `/Users/cedric/Documents/ClawSense/src/utils.ts`
- `/Users/cedric/Documents/ClawSense/test/*`

### Product Surface / Review Experience Agent 可优先编辑

- `/Users/cedric/Documents/ClawSense/src/review-engine.ts`
- `/Users/cedric/Documents/ClawSense/skills/clawsense-daily-review/SKILL.md`
- `/Users/cedric/Documents/ClawSense/README.md`
- `/Users/cedric/Documents/ClawSense/docs/*`
- `/Users/cedric/Documents/ClawSense/android/README.md`

## 6. 工作规则

### Rule 1: 不要给每个 agent 全量上下文

每个 agent 只需要：

- 一页共享背景
- 本模块目标
- 本模块文件范围
- 本模块验收标准

不要把整仓库所有历史和愿景全部灌给每个人。

### Rule 2: 每个 agent 都必须有清晰“完成定义”

例如：

- Android agent 的“完成”，不是“我改了几个文件”，而是“真机状态和上传行为达标”
- Backend agent 的“完成”，不是“我建了几个 type”，而是“Review 和 media library 能产出稳定结果”

### Rule 3: 任何共享协议改动都必须写明影响

特别是：

- request / response JSON
- `CaptureEvent`
- `DailyReview`
- Android 上传 payload

### Rule 4: 每个 agent 的输出都要能被快速验收

统一要求：

- 改了什么
- 为什么改
- 怎么验证
- 还有什么风险

## 7. 推荐分支策略

建议每个执行 agent 使用独立分支，例如：

- `codex/android-sensor`
- `codex/backend-intelligence`
- `codex/review-experience`

统筹 agent 不直接在执行分支上长期开发，而是：

- 看 PR / patch / diff
- 控制共享契约合并
- 必要时做集成分支

## 8. 当前阶段推荐的第一批任务

### Android / Sensor Agent

第一批任务建议：

- 保持 round-4 长对话分段不回退
- 继续验证更多机型上的前台服务 / CameraX / 音频稳定性
- 为后续普通聊天页接入保留稳定的 `csAudio:v2` 连续会话线索
- 除非有真实设备证据，不主动大改录音参数

### Backend / Event Intelligence Agent

第一批任务建议：

- 保持 `CaptureEvent` / 会话合窗 / review 引擎稳定
- 推进普通聊天页正式接入 ClawSense skill / tool / context
- 补强开源部署的 provider 标准化与 failure reason 可解释性
- 保持 multimodal primary + runtime STT fallback 路线稳定
- 继续守住 artifact retention 与清理策略

### Product Surface / Review Experience Agent

第一批任务建议：

- 保持媒体库继续朝“同 host、同 origin、零额外配置”的独立轻量页方向收敛
- 把普通聊天页入口与 Daily Review Skill 路径正式说顺
- 完善人物 / 项目最小标注闭环
- 把 README / Guide / 演示路线整理成面向外部用户可直接照抄的版本
- 明确“值得留意的社交线索”表达边界，避免心理学式结论

## 9. 什么时候再继续拆 agent

只有在下面情况出现时，才建议继续拆：

- Mac 客户端正式立项
- Web 固定回顾页开始单独建设
- 独立的 STT / ASR 基础设施显著复杂化

那时再新增：

- `Mac/Desktop Agent`
- 或 `Dedicated Speech Infrastructure Agent`

在当前阶段，不建议超过 `3` 个执行 agent。

## 10. 交付格式建议

每个执行 agent 完成任务时，统一按这个格式交付：

1. 目标
2. 实际改动
3. 验证结果
4. 风险 / 未完成项
5. 是否触碰共享契约

这样统筹 agent 可以快速整合，不需要重新读完整上下文。
