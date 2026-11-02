# nanoMuse 源码复用与实现边界评估

日期：2026-10-14。依据 [产品愿景](../../VISION.md)。本次是静态源码与上游许可核对，尚未构建 nanoMuse APK、真机联调或测量性能；没有将上游代码合入 ClawSense。

## 建议

以 nanoMuse 作为端侧个人助手架构和交互的参考、可选的真实宿主；ClawSense 自建原生现场运行时与私人证据记忆。需要通用 Agent 能力时，直接评估 DSH 或 Pi 的 MIT 上游。需要 VAD 等能力时，直接集成许可清楚的原始库。

这条路线能保留 ClawSense 的 MIT 核心与手机／手表分发选择，同时借鉴 nanoMuse 已验证到源码层面的设计。整体 fork nanoMuse 也是可行选项，但其产品代码按 GPL 路线分发，且实时音视频差距仍需补齐。

## 审计对象与许可口径

- nanoMuse 审计提交：[3428c15fc1eb57945a6c1bb42b53db9ceffa812f](https://github.com/nano-muse/nanoMuse/tree/3428c15fc1eb57945a6c1bb42b53db9ceffa812f)。
- 根项目、自有 runtime／relay／web／desktop 代码为 GPL-3.0-or-later；Android/iOS 来自 GPL-3.0 的 OpenMinis 子树。nanoMuse 的 DSH 插件本身仍是 GPL，不能因 DSH 是 MIT 就将该插件视为 MIT。
- 依据：[LICENSE](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/LICENSE)、[第三方清单](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/THIRD_PARTY_NOTICES.md)、[dsh-nanomuse package.json](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/harness/dsh-nanomuse/package.json)。
- “可按 MIT 复用”仅指已核对的上游代码，不表示其全部依赖、模型权重、字体、数据、商标及远程服务条款也都是 MIT。合入时锁定具体版本、保留版权与许可，核对传递依赖和模型分发条件。
- GPL 修改版对外分发适用相应源码要求；接口拆分不能单靠“用了 HTTP/MCP”就断言完全独立，组合边界需看实际实现。[GNU FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)

## nanoMuse 哪些设计值得借鉴

以下源码路径均相对审计提交，Android Java 根目录为 `android/src/android/app/src/main/java/`。

| 模块／路径 | 源码事实 | ClawSense 的处理 |
| --- | --- | --- |
| `com/openminis/app/sandbox/NativeOffload.kt` 与 offload handlers | 沙箱命令可桥接原生设备能力；执行环境与系统 API 有明确接口 | 学习能力桥接，独立定义采集、看当前画面、停止与设备状态接口 |
| `com/openminis/app/data/repository/ProviderRepository.kt`、`provider/voice/` | 将模型配置、语音输入输出供应商与具体调用分开 | 自建能力路由契约，包含 local/owned-device/external、模态、流式能力与许可回退 |
| `io/github/nanomuse/hands/` | 手机 GUI 操作与动作进度、用户接管相结合 | 后续资深用户扩展参考；不作为首版现场 Live 的依赖 |
| `io/github/nanomuse/hub/HubClient.kt`、`reach/` | WebSocket 设备发现、请求、进度、结果和重连 | 借鉴跨设备消息分工；另补可恢复任务、幂等回执与取消语义，不能假定每个事件可靠到达 |
| `com/openminis/app/speech/VoiceOutputState.kt`、`ReadAloudPlayer.kt` | 全局语音状态、句子队列、停止／暂停及系统语音回退 | 学习控制体验；为 Live 自建“取消旧轮次及其全部待播音频”的代际控制 |
| MCP UI 与 `assets/default_mount/usr/local/lib/minis-mcp-cli/` | 支持 HTTP MCP、自定义 headers 与认证 | 可先把 nanoMuse 作为 ClawSense 的独立宿主做验证，无需搬入整套 App |
| `harness/dsh-nanomuse/` | 产品人格、连接器、手机操作、界面通过 DSH bundle 扩展 | 可从 DSH 上游独立开发 ClawSense bundle，保留我们自己的产品与协议 |

上述模块的 nanoMuse 实现不是可直接拷进 MIT 核心的 MIT 代码。可以复用设计思路、接口需求和观察到的行为；选择 MIT 路线时，代码从原始许可清楚的上游取得或独立编写，不复制 GPL 实现后改标 MIT。

## Live 音视频的真实差距

### 人声检测与轮次

`speech/VoiceActivityDetector.kt` 使用 RealTimeCutVADLibraryForAndroid、Silero v5、48 kHz 采集，包含预录缓冲和噪声自适应。默认 END_FRAMES=156，约五秒尾部静音；后台超时十五秒，连续采集上限三百秒。它服务于语音输入分段，不是全天现场参与策略。

`ProviderSpeechRecognitionEngine.kt` 的 supportsPartialResults=false，供应商路径按片段上传识别；系统引擎可以提供部分结果，但受设备语音服务与 API 能力影响。两者不能概括成完整端侧实时推理。

ClawSense 当前 `AndroidAudioSensorHal.kt` 主要按 RMS 判断，并用一个录音循环处理环境采集与显式提问；已包含预录、停顿、上限及缓冲隔离。这是可替换 VAD 的基础，不需要同时再开一个录音器。nanoMuse 使用的 VOICE_RECOGNITION 音源不能直接照搬：ClawSense 源码已记录部分设备此音源读到近零数据，当前 MIC 有实测基线。

### 播报和打断

nanoMuse `ReadAloudPlayer.kt` 在录音时 suspendForCapture，并可以恢复尚未播出的句子；供应商 TTS 先合成字节再播放，队列逐句运行。这有助于朗读控制，但没有证明“助手说话时持续听取、识别用户插话、丢弃旧答案并立即转入新问题”。

ClawSense 现阶段通过暂停环境入库与尾音隔离防止自我触发，也不是完整双工。新 Live 模块需拥有唯一音频设备管理、播放参考／回声路径、轮次状态、取消 ID 和部分结果处理。库包含 WebRTC APM 不等于我们的整机回声消除已经成立；必须检查播放参考接入并做扬声器真机测试。

### 图像视频

Android Manifest 写明拍照是前台用户触发，`ChatScreen.kt` 通过 ACTION_IMAGE_CAPTURE 获取附件。nanoMuse 的 `io/github/nanomuse/media/MediaOffloadHandler.kt` 的 image/video 是图片与视频生成，不是摄像头持续采集。

ClawSense 已有 `CameraXImageSensorHal.kt` 的 JPEG、短 MP4 与起止关联图片，应保留并抽成独立原生模块。当前短视频按 video-only 实现；后续音视频联合理解需要共同时间轴与音频区间关联，不能宣称已有带音轨视频。

Live 视觉先验证“新鲜的当前帧 + 说话时间”，再验证动作或变化所需短片。仅看关键帧不能算理解完整视频。手机执行一次拍照或读取附件，不等于助手一直看得见现场。

### 本地运行

nanoMuse 将编排与工具放到手机，不保证模型推理本地。其 Linux 沙箱也不是本地语音模型引擎。ClawSense 要按 ASR、VAD、TTS、语言推理、视觉、嵌入分别记录位置和能力。

本轮未发现 Android 侧已经完成本项目要求的声纹身份、多人重叠处理、低延迟全双工与长期连续相机链路；这表示不能把它们计入复用收益，不是对仓库全部未来能力的否定。

## 可从 MIT 上游直接开发的候选

已读取以下上游的 LICENSE／COPYING 并记录提交；详见 [许可证据清单](upstream-license-evidence-2026-10-14.json)。

| 上游 | 许可 | 用途与优先级 | 复用边界 |
| --- | --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE) | MIT | 首选桌面／自有设备执行宿主；现有实际 DSH 验收可复用 | 已核 npm 0.2.0-rc.2 声明 MIT；完整打包依赖需按最终 lockfile 审核。其客户端、插件不自动等同于 nanoMuse 插件 |
| [Pi](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/LICENSE) | MIT | 轻量 Agent loop、模型与工具事件接口候选 | 当前上游已从 badlogic/pi-mono 重定向；版本和包名须锁定，不直接假设 Node 工具链能原样跑在 iOS |
| [RealTimeCutVADLibraryForAndroid](https://github.com/helloooideeeeea/RealTimeCutVADLibraryForAndroid/blob/a4450c2b5fb0f2d14a9ef2ac727e0ee2ae9a9116/LICENSE) | MIT | 首批 Android VAD 对照原型 | nanoMuse 锁的是 1.0.5；本次许可核对为表列提交，打包前再核实际 AAR/依赖。自行接入我们的录音循环，不能复制 nanoMuse 的 GPL 包装类 |
| [Silero VAD](https://github.com/snakers4/silero-vad/blob/1e261b036686cd0017d500ee96acd1c4ba572a9d/LICENSE) | MIT | 直接 VAD 推理方案，与包装库对比 | 不负责识别说话人、理解语义、判断是否在叫助手；具体模型文件仍需锁定 |
| [Shizuku API](https://github.com/RikkaApps/Shizuku-API/blob/a27f6e4151ba7b39965ca47edb2bf0aeed7102e5/LICENSE) | MIT | 后续 Android 高级设备接口 | 此结论只覆盖 API 仓库；用户服务与平台许可另核。普通用户不以 Shizuku 为前置 |
| [MemGUI-Bench](https://github.com/lgy0404/MemGUI-Bench/blob/3fb01b6cc0d13e287c67f488c76f449df7d65558/LICENSE) | MIT 代码 | 后续手机 GUI 操作原型参考 | 直接读取原始 operator，不复制 nanoMuse 加工后的整文件；数据与依赖单独核对 |
| [rclone](https://github.com/rclone/rclone/blob/4983d291e66c590a75acd4f9cf0d50e61230f6d3/COPYING) | MIT | 用户指定位置的备份与导出候选 | 最终二进制依赖及备份密钥管理独立审核；备份不是多端写入同步协议 |

Compose、CameraX、OkHttp 等可继续使用，但它们通常是 Apache-2.0，不能统称 MIT。PROot／OpenMinis 及其系统包不是“整个端侧 runtime 都是 MIT”。nanoMuse 的标识、头像与演示数据也不随某个 MIT 依赖变成可任意分发资源。

对于 DSH/Pi，近期只选一个承担默认打包体验，另一种保留为适配与比较，避免同时养两套产品状态。当前已有 DSH 验收，桌面路径优先延续 DSH；手机内核通过 P1/P2 实测再确定，不凭桌面表现认定其最合适。

## 必须由 ClawSense 掌控的模块

| 模块 | 核心要求 |
| --- | --- |
| CaptureCoordinator | 唯一麦克风／相机所有者；原生采集；时间戳；有界缓冲；状态与真正停止；耳机／扬声器切换 |
| LiveSession | listening / thinking / speaking / interrupted / disconnected 等状态；低延迟轮次；取消旧流与待播；短答／全文一致 |
| PresencePolicy | 观察材料与指令区分；点名／邀请；公共、私密和会后输出；多人场景角色 |
| PersonalMemory | 原件、分析、更正、人物与身份关系；撤回与删除；证据版本；不自动把所有历史塞进模型 |
| ContextBroker | 在读取、检索、原件与模型出站前裁剪权限；记录供应商和实际发出内容；拒绝无声云端回退 |
| AgentAdapter | 明确区分工具读取、真实执行、会话接续；持久化请求、取消和成果；默认支持不依赖具体厂商 |
| DeviceSync | 单节点单写入者、离线队列、版本冲突、删除墓碑、端间归属转移；当前桌面权威到未来手机权威的显式迁移 |
| WatchCapture | 本地录音片段、标记、手机传输、重复／缺口检查、轻交互；根据设备平台开发 |

这些能力是产品判断与现场体验所在，完整外包给通用 Agent 会让低延迟、隐私和可靠性变成不可控依赖。

## 三种复用路线的取舍

| 路线 | 得到什么 | 代价 | 本轮判断 |
| --- | --- | --- | --- |
| nanoMuse 外部宿主 + ClawSense MCP | 最快验证其端侧 Agent 能否消费我们的真实证据 | 不自动获得实时音视频通道；手机与 Host 可达性仍需解决 | 作为兼容验证；不是 Live 的先决条件 |
| 独立 ClawSense App + MIT／Apache 上游组件 | 对 Live、手机／手表、记忆与分发保持控制 | 自己完成会话、同步和产品界面 | 推荐产品主线 |
| 整体 fork nanoMuse | 尽快得到完整通用 Agent App 和大量设置／工具 | GPL 分发、上游同步、沙箱体积与系统限制；仍要补 Live | 作为独立评估选项，不作为默认迁移决定 |

## 首批可复现实验

1. 同一获准音频片段、同一手机比较当前 RMS 与上游 VAD：起音截断、短句保留、电视人声、噪声误触发、CPU 与电耗。
2. 同一录音器同时供 Live 与按策略保存证据；不得额外开 nanoMuse 录音器。先测显式开始／停止，再测打断。
3. 同一问题使用当前拍摄帧，验证图像年龄、音画时间关联以及模型实际收到原图；不只看 MCP tools/list。
4. nanoMuse 独立连接测试库，读取证据、处理一次纠正、回写成果；使用真实客户端，记录图片内容块是否被正确消费。
5. 在断网模式测本地 ASR／TTS／推理／视觉各自能做什么；用外网请求记录证实本地承诺。

每次报告固定手机、系统、模型、依赖版本、代码提交与原件范围。后续开发按 [执行计划](../产品演进路线与执行计划.md)进行。

## 来源路径索引

- [nanoMuse Android 源码](https://github.com/nano-muse/nanoMuse/tree/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/android/src/android/app/src/main)
- [VAD 包装实现](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/android/src/android/app/src/main/java/com/openminis/app/speech/VoiceActivityDetector.kt)
- [供应商 ASR](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/android/src/android/app/src/main/java/com/openminis/app/speech/ProviderSpeechRecognitionEngine.kt)
- [朗读控制](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/android/src/android/app/src/main/java/com/openminis/app/speech/ReadAloudPlayer.kt)
- [图像视频生成模块](https://github.com/nano-muse/nanoMuse/blob/3428c15fc1eb57945a6c1bb42b53db9ceffa812f/android/src/android/app/src/main/java/io/github/nanomuse/media/MediaOffloadHandler.kt)
- ClawSense 当前：[音频](../../android/app/src/main/java/ai/openclaw/clawsense/sensors/AndroidAudioSensorHal.kt)、[相机](../../android/app/src/main/java/ai/openclaw/clawsense/sensors/CameraXImageSensorHal.kt)、[服务](../../android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt)、[MCP](../../src/mcp-server.ts)、[G2 契约](../G2统一上下文准备方案.md)。
