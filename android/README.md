# ClawSense Android MVP

这个目录是 ClawSense 的 Android 最小可用版骨架，目标是先跑通：

- 首次扫码/引导码配对
- 保存永久 `deviceSecret`
- 跳过重复配对 UI
- 前台服务采集
- 音频 VAD 触发上传
- 基线 60 秒定格拍照上传
- 音频活跃窗口内 10 秒定格拍照上传
- 现实世界实时语音提问与本地 TTS 播报
- WorkManager 背景心跳

## 先看哪份文档

如果你是第一次接手这个项目，建议先看总指南：

- [小白部署与使用指南](../docs/小白部署与使用指南.md)

这份 `android/README.md` 只聚焦 Android 客户端本身，默认你已经知道：

- 服务端已经可访问
- OpenClaw 当前推荐由原生多模态模型驱动
- `openclaw clawsense pair` 怎么生成二维码
- 配对成功后会拿到永久 `deviceSecret`
- 当前 App 页面里的运行状态分别代表什么

另外还要明确一点：

- 当前 Android 客户端仍然走 ClawSense 自己已经跑通的配对与 ingest 数据面
- 后续会考虑兼容 OpenClaw 官方控制面
- 但那会是“官方控制面兼容 + ClawSense 数据面保留”的混合架构，不是现在这版 Android 客户端的前置条件

## 目录结构

- `app/src/main/java/ai/openclaw/clawsense/MainActivity.kt`
  UI 入口，负责配对、权限申请、启动/停止感知服务。
- `app/src/main/java/ai/openclaw/clawsense/data/*`
  通信、配对协议、永久会话存储。
- `app/src/main/java/ai/openclaw/clawsense/sensors/*`
  传感器 HAL 抽象和 Android 实现。
- `app/src/main/java/ai/openclaw/clawsense/service/*`
  前台服务、通知、心跳载荷。
- `app/src/main/java/ai/openclaw/clawsense/work/*`
  BootReceiver 和 WorkManager 心跳补偿。

## 环境要求

- Android Studio 新版稳定版
- JDK 17
- 首次打开 `android/` 后，让 IDE 自动下载 Gradle 8.7 与 Android SDK 34
- 第一次打开如果提示缺少 SDK：
  - 安装 `Android SDK Platform 34`
  - 安装 `Android SDK Build-Tools`
  - 安装 `Android SDK Platform-Tools`

## 当前行为

### 配对

- 支持扫码读取二维码内容
- 支持手动输入 `Host + Setup Token`
- 支持粘贴服务端输出的整段引导码
- 如果二维码里的 Host 是 `lan / localhost / 127.0.0.1 / 0.0.0.0` 这类不可直连地址，App 会提示改用手动 Host，避免一直握手失败
- 配对成功后，把 `host + deviceSecret + uploadBaseUrl` 写入安全存储
- 当前 MVP 默认允许明文 HTTP，原因是现阶段服务端仍可能部署在 `http://你的服务器IP:18789`

### 感知服务

- 服务端已实现的接口：
  - `POST /api/clawsense/pair`
  - `POST /api/clawsense/ingest/audio`
  - `POST /api/clawsense/ingest/image`
  - `POST /api/clawsense/assistant/query`
  - `POST /api/clawsense/heartbeat`
- 前台服务启动后：
  - 麦克风持续做 RMS 阈值检测
  - 检测到声音片段后，打包为 WAV 上传
  - 相机在服务运行期间默认每 60 秒拍一张 JPEG 上传
  - 检测到音频活跃窗口后，相机临时提升为每 10 秒 1 张，持续 120 秒
  - 心跳按服务端返回的间隔发送
- 如果只授予了相机或麦克风中的一个权限，服务会自动进入降级模式：
  - 只有麦克风权限：只上传音频和心跳
  - 只有相机权限：只上传图片和心跳
- WorkManager 每 15 分钟发送一次后台补偿心跳

### 实时语音助手

当前 Android 客户端也是 ClawSense 的语音入口：

- App 可以把一次显式语音提问提交到 `/api/clawsense/assistant/query`
- 服务端负责选择 `last_15s / last_60s / last_5m / custom / day` 等 evidence 范围并生成回答
- Android 端显示完整 `answerText`
- Android 端用本地 TTS 朗读更短的 `answerSpokenText`
- `读全文 / 停止朗读` 是确定性控制，不依赖模型自由发挥
- 播报期间会进入 echo drain，避免把手机自己的 TTS 再录成环境音频
- 如果收到 `401 unauthorized`，客户端会停用当前服务并提示重新配对，避免无限重试

### 推荐服务端模型

Android 客户端本身不依赖多模态模型才能“上传成功”，但 ClawSense 的产品目标已经变成：

- 先采集与归并事件窗口
- 再让 OpenClaw 当前主模型做关键窗口分析
- 最后生成日回顾

所以推荐服务端使用原生多模态 OpenClaw；`runtime STT` 现在是兜底，而不是主分析路径。

### Android 在用户路径里的位置

当前这版 Android 客户端的职责很明确：

1. 负责持续采集音频、图片和心跳
2. 把原始感知送回 ClawSense 数据面
3. 作为语音入口，把用户的显式问题转发给 OpenClaw / ClawSense evidence 层
4. 让你之后能在服务端打开媒体库，或生成 Daily Review

也就是说：

- Android App 负责“采”
- `/plugins/clawsense/library` 负责“看原始感知”，首次打开需要当前 OpenClaw 的 gateway token
- `openclaw clawsense review today` 和 Daily Review skill 负责“做助理式回顾”
- 如果你就在普通聊天页里提问，也应该显式走 ClawSense skill / tool，而不是让模型自己扫文件系统

最小补标注路径也是跟着这条链走：

1. Android 负责先把素材采回来
2. 服务端先用 `/plugins/clawsense/library` 确认采集是否完整
3. 再运行 `openclaw clawsense review today`
4. 如果 review 里有人物身份不清楚，再用 `openclaw clawsense annotate <personRef> <displayName> [notes...]` 补回去

项目 / 主题这轮暂时不单独做新命令，先通过 review 里的追问来补清楚。

媒体库的目标访问方式也要记住：

- 默认复用你当前访问 OpenClaw 的同一地址
- 不要求你自己配置域名或反向代理
- 不依赖任何 ClawSense 官方公网域名
- 最终应该是同 host、同 origin 的独立轻量页，而不是聊天控制页的壳

不要把 Android App 本身理解成最终回顾入口；当前最终回顾仍然在 OpenClaw 侧完成。

## 平台限制

- Android 14 及以上机型，对相机前台服务和开机自恢复限制更严格。
- 所以这个 MVP 的可靠基线是：
  - 配对后重开 App 自动跳过配对页
  - 已授权且已启用服务时，打开 App 可自动恢复前台服务
  - 开机后的完全无 UI 相机恢复，不承诺对所有 ROM 都可靠

## 首次打开后的操作

1. 用 Android Studio 打开 `android/`
2. 让 IDE 自动同步 Gradle
3. 安装到旧 Android 手机
4. 先扫码或手动配对
   - 手动 Host 一般填 `http://你的服务器IP:18789`
5. 授予：
   - 相机
   - 麦克风
   - 通知
6. 点击“启动感知服务”

## 还未做的内容

- 真正的息屏 OLED 低功耗模式
- 上传失败队列与断点续传
- 多机型相机兼容性修正
- 更强的 VAD/降噪策略
- 设备管理页（撤销设备、查看最近上传）
- 用非废弃方案替换 `EncryptedSharedPreferences`
- Android 端视频采集 / CameraX 录制 M2
- 语音开启视频
- 基于面部画面的微表情、情绪或内在意图自动结论
