# Pipecat Live 对照运行约定

更新日期：2026-10-29。依据 [产品愿景](../../VISION.md) 和 [现行执行计划](../产品演进路线与执行计划.md)。这是可选的 P1 候选入口，基础模型运行在自有电脑。原 Android 采集、旧 Live 和 OpenClaw 入口保留；上游接入不代表 P1 整阶段验收。

## 职责和数据流

Android 官方 SmallWebRTC 客户端负责音视频设备与媒体传输，Pipecat 负责 VAD、Smart Turn、语段聚合、打断、合成队列及输出。ClawSense 提供受设备权限约束的本地识别、语言、视觉和声音模型，以及来源检查、记忆与更正。

Pipecat 不调用旧 LiveSession。取消由 Pipecat 清理队列、关闭对应的模型 HTTP 请求；ClawSense 将请求关闭传递给该次推理的 AbortController。不得另发一个无回答归属的异步取消请求，否则可能在下一问开始后误伤新回答。语音“停”在上游完成打断后静默结束，不交给语言模型再生成一条口头回应。

新入口目前负责现场问答、当前画面与获准记忆；从语音主动执行外部 Agent 工作仍使用原有入口。已有 MCP、工作状态、成果审核和复用协议继续保留。停止说话不声称取消或撤回外部工作。

## 安装与启动

固定的服务端依赖在 `scripts/live/upstream/requirements.txt`；Android 使用 `ai.pipecat:small-webrtc-transport:1.2.2`，保持上游许可声明。当前 Android 构建使用 Kotlin 2.3.10、AGP 8.13.0、Gradle 8.13、compileSdk36；targetSdk34 和原应用身份保持。

已具备可用本地模型配置时，可以准备一个全新目录：

```bash
python3 scripts/live/upstream/prepare.py \
  --source-config /absolute/path/to/existing-live.json \
  --directory .local/upstream-live \
  --install
```

准备程序只复用本地模型路径，创建私有配置、随机桥接凭据和隔离依赖。它拒绝覆盖非空目录，不启动采集或服务，不复制云端凭据或启用外部模型。原配置和状态目录保持独立。

分别启动伴随服务和侧车：

```bash
node dist/src/cli.js live-serve \
  --state-dir .local/upstream-live/state \
  --config .local/upstream-live/config.json --port 19721

.local/upstream-live/venv/bin/python scripts/live/upstream/runtime.py \
  --bridge-url http://127.0.0.1:19721 \
  --token-file .local/upstream-live/bridge-token --port 19723
```

侧车仅监听回环地址。Android 使用现有配对凭据，经伴随服务的 `/api/clawsense/live-upstream/offer` 交换 WebRTC 信令；模型接口还要求侧车私有凭据，不向手机提供该凭据。准备目录默认使用19721／19722／19723三个不同端口；若占用，应使用准备程序的端口参数并同步启动命令。

同一局域网接入时，伴随服务须以 `--host 0.0.0.0` 监听，并将配置的 `publicBaseUrl` 指向实际 Mac 局域网地址；如需在该隔离服务中使用旧 Live，另将 `live.host` 设为 `0.0.0.0`。侧车地址仍为回环。不要关闭用户的 VPN；按实际路由验证连接。

默认不配置公共 STUN／TURN。WebRTC 媒体需要双方可达的网络路径；USB 的 adb TCP 端口转发不能直接证明 UDP 媒体可达。跨网络、严格防火墙或受限 VPN 场景需单独验证用户所选的私有中继，不能把本机回环检查外推为远程支持。

## 手机体验与设备所有权

调试候选的旧 Live 页面提供“进入 Live 对照版”。用户手动开启后，SDK接管本次媒体；原感知与旧 Live 不得同时占用麦克风。SDK准备好后再启用音轨；此状态不替代真实硬件读音检查。

对照页面沿用当前公开／本人设置。镜头需单独勾选；开启后传送画面，只有相关提问会请求本地视觉分析。离开页面、结束会话或失去音频焦点会释放连接和设备。本轮手机窗口最多两分钟。构建时不会自动采集或播放。

音频使用上游 WebRTC 的通话属性，音量键控制对应通话音量；不自动调整系统音量数值。没有外接耳机时选择扬声器，结束时恢复本次接管前的路由与模式。耳机、来电和锁屏组合仍须按设备实际验证。

“停止朗读”发送上游停止控制；“结束 Live”始终可结束整个会话。声音停止与外部工作取消是独立状态。

## 来源和记忆

每次模型调用都验证配对身份、项目和处理位置，音频生成期间继续验证来源。Pipecat的播放回执绑定具体回答；未播放或被打断而无法精确对齐的文字不记作用户已听到的完整回答。文本渲染由可信上游处理，授权依赖回答编号和来源，不以原始字符串包含关系代替生命周期。

用户陈述和完成的回答保存在现有受管检查点目录，绑定原来源；重新连接时重新检查权限和来源版本。删除原证据会删除关联检查点。公开场景不向模型传递私人历史；公开／本人设置变化使当前上游会话失效，需要重新开启。撤销处理权限后，侧车结束会话；即使权限已经撤销，持原会话凭据的受信侧车仍可执行只释放资源的清理操作。

当前帧缓存最多一张，不写入原始图片；超过两秒未收到新帧则拒绝把它作为当前画面。WebRTC对照帧的时间依据是运行时接收时间，尚未校准设备拍摄时间，证据中明确记录这一点。收到视频流、采样一帧和理解完整动作是不同能力。

## 验证与已知边界

自主检查入口包括 `check_pipeline.py`、`check_legacy.mjs`、`check_webrtc.py`、`check_boundaries.py`、`compare_audio.py`；这些开发检查不随运行包分发。HF对照使用独立环境，不能与Pipecat叠加成为第二个轮次控制者。

自动输入为生成素材；输出为静音数字接收／播放队列，不打开真实麦克风或扬声器。此结果不替代手机听感和声学回声检查。最终能力、失败和统计口径见[本轮验收记录](../validation/p1-upstream-2026-10-29.md)。
