# Android 四栏 UI 重构验证（2026-10-13）

## 交付与基线

- 分支：`codex/android-ui-tabs`。
- 以主工作目录的 `c2860606192a743fc66c716cf24d22de0bc333d6` 加其未提交源码为基线，同步 249 个源码文件到本工作区。主目录源码逐文件校验保持一致；未复制运行时数据、凭据、SDK 配置或构建产物。
- 基线哈希、原始补丁及源码副本保存在本机 `.local/ui-tabs-baseline/`。本轮 UI 独立补丁与改动清单在 `.local/ui-tabs-validation/`；Git 工作区同时包含用户授权同步的原有改动。
- 默认打开助手，一级导航为「助手 / 记忆 / 感知 / 设置」。连接、权限、偏好、诊断、草稿和记忆详情使用独立页面。
- 主 Activity 只保留系统入口，界面拆分到 `ui/`；数字记忆由独立 ViewModel 管理。数据格式、两类凭据与感知上传协议不变。
- 系统分享先在仍持有临时 URI 授权的入口 Activity 内保存，再转入记忆。恢复导入使用批次内稳定 ID，防止重复创建；未确认的草稿不入同步队列。

## 自动检查

使用 Android Studio JBR 和本机 Android SDK：

```bash
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./android/gradlew -p android :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest
```

结果：Debug APK 与测试 APK 构建成功，**30 项 JVM 单元测试通过**。

在 `Medium_Phone_API_36.1` 模拟器安装上述 APK，执行：

```bash
adb -s emulator-5554 shell am instrument -w -r \
  -e class ai.openclaw.clawsense.ui.AppUiTest,ai.openclaw.clawsense.ui.DigitalStateTest \
  ai.openclaw.clawsense.debug.test/androidx.test.runner.AndroidJUnitRunner
```

结果：**12 项设备测试通过**，覆盖：

- 四栏导航、详情返回、Tab 切换后的模式与搜索保留、系统状态恢复。
- 未配对状态、权限修复入口、录音期间防重复提交、跨页停止朗读入口。
- 长回答固定语音按钮、320dp 小屏、深色主题、200% 字体。
- 未保存草稿恢复、显式保存前不写入本机记录、保存后仍是未同步草稿。
- 文字分享重放去重、图片批量导入及重放去重、临时图片 URI 失效后的已导入内容复用。

UI 测试依赖显式使用 Espresso 3.7.0，解决旧版测试框架访问 Android 16 已移除的 `InputManager.getInstance` 问题。见 [AndroidX Test 发布说明](https://developer.android.com/jetpack/androidx/releases/test)。

## 模拟器完整路径检查

使用仅绑定本机回环地址的隔离 HTTP fixture；接收计数而不保存上传媒体，不连接真实 OpenClaw 状态目录。

- 新感知页成功启动音频及相机 HAL；经过记忆、设置、助手的 Tab 切换，运行中的服务没有重新启动。
- 手动 6 秒视频成功上传，日志确认带 2 张关键帧；定时图片上传成功。
- 新助手按钮成功进入显式录音；无语音输入时回退到可重试状态并展示错误。
- 从 UI 停止服务后，检查服务列表为空。
- 撤销相机权限后启动为「仅音频」，撤销麦克风权限后启动为「仅图片」，两种模式均能从 UI 停止；测试后恢复模拟器权限。
- 外部文字分享进入本机编辑页，未连接时仍可保存，没有启动感知服务。

这些结果仅证明模拟器与隔离 fixture 上的路径。真人语音回答质量、实际 TTS 听感、手机相机兼容性不能由这些结果替代。

## 视觉检查与限制

已检查助手、记忆、感知、设置、长回答、深色大字体、小屏和外部分享草稿的截图；详情页面给系统手势区域留白。截图及运行日志位于本机 `.local/ui-tabs-validation/`。

### 真机补验（2026-10-13）

用户提供新的无线调试信息后，已重新连接 PDEM10 真机，并通过 `adb install -r` 覆盖安装交付 APK。安装包 SHA-256 与手机上的 `base.apk` 完全一致，原首次安装时间保留。

- 安装前、安装后和导航检查后的加密会话文件 SHA-256 一致，现有业务配对与配置保留。
- 已实拍核对助手、记忆、感知、设置四栏，以及感知设备连接、权限、感知偏好页面；主操作首屏可见。
- 工具栏返回、Android 返回键、详情返回设置、设置返回助手均验证成功。
- 检查期间当前 App 进程没有 AndroidRuntime 错误。感知服务保持原来的停止状态，结束时停留在助手首页。
- 真机截图、安装包一致性证明与会话校验结果位于 `.local/ui-tabs-validation/physical-device/`。

本次真机补验包括覆盖安装、数据保留、布局与导航；真人问答质量、实际采集上传和 TTS 听感仍未在真机重复验收。

`lintDebug` 剩余 **1 个既有错误**：`SensorForegroundService.onStartCommand` 缺少 `super.onStartCommand`（`MissingSuperCall`）。该文件与同步基线逐字节一致，本轮未更改服务生命周期实现。其余 27 项警告主要为既有依赖版本、平台配置及资源提示。已修正本轮触及扫码代码中的 CameraX opt-in 标注。
