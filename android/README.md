# ClawSense Android MVP

这个目录是 ClawSense 的 Android 最小可用版骨架，目标是先跑通：

- 首次扫码/引导码配对
- 保存永久 `deviceSecret`
- 跳过重复配对 UI
- 前台服务采集
- 音频 VAD 触发上传
- 每 5 分钟定格拍照上传
- WorkManager 背景心跳

## 先看哪份文档

如果你是第一次接手这个项目，建议先看总指南：

- [小白部署与使用指南](/Users/cedric/Documents/ClawSense/docs/小白部署与使用指南.md)

这份 `android/README.md` 只聚焦 Android 客户端本身，默认你已经知道：

- 服务端已经可访问
- `openclaw clawsense pair` 怎么生成二维码
- 配对成功后会拿到永久 `deviceSecret`
- 当前 App 页面里的运行状态分别代表什么

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
- 配对成功后，把 `host + deviceSecret + uploadBaseUrl` 写入安全存储
- 当前 MVP 默认允许明文 HTTP，原因是现阶段服务端仍可能部署在 `http://你的服务器IP:18789`

### 感知服务

- 服务端已实现的接口：
  - `POST /api/clawsense/pair`
  - `POST /api/clawsense/ingest/audio`
  - `POST /api/clawsense/ingest/image`
  - `POST /api/clawsense/heartbeat`
- 前台服务启动后：
  - 麦克风持续做 RMS 阈值检测
  - 检测到声音片段后，打包为 WAV 上传
  - 相机在服务运行期间每 5 分钟拍一张 JPEG 上传
  - 心跳按服务端返回的间隔发送
- 如果只授予了相机或麦克风中的一个权限，服务会自动进入降级模式：
  - 只有麦克风权限：只上传音频和心跳
  - 只有相机权限：只上传图片和心跳
- WorkManager 每 15 分钟发送一次后台补偿心跳

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
