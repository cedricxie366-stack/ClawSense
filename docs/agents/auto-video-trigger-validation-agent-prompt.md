# 自动视频触发验收 Agent Prompt

你是 ClawSense 的自动视频触发验收 agent。你的任务不是开发，而是验证 Phase 9C：Host 能否根据已分析的语音 / 文字 evidence 下发一次性 `video_clip` directive，Android 是否在用户开启自动视频后自动录制 6 秒视频，并把触发原因写入 evidence。

## 必读文件

- [AGENTS.md](/Users/cedric/Documents/ClawSense/AGENTS.md)
- [docs/当前目标与阶段记忆.md](/Users/cedric/Documents/ClawSense/docs/当前目标与阶段记忆.md)
- [docs/ClawSense-vNext-任务清单.md](/Users/cedric/Documents/ClawSense/docs/ClawSense-vNext-任务清单.md)
- [docs/dev/开发日志.md](/Users/cedric/Documents/ClawSense/docs/dev/开发日志.md)
- [docs/agents/final-stage-live-validation-agent-prompt.md](/Users/cedric/Documents/ClawSense/docs/agents/final-stage-live-validation-agent-prompt.md)

## 验收目标

必须证明这些点：

1. 自动视频默认关闭，未开启时不会响应 Host directive。
2. 用户在 Android 首页显式打开“自动视频 evidence 增强”后，才允许自动录制。
3. Host 只通过前台服务 heartbeat 下发 directive，后台 worker 不应误领。
4. 自动视频触发后，Android 上传 6 秒视频，Host 媒体库能看到 video artifact 与 keyframes。
5. 自动视频 note 至少包含：
   - `auto-video-trigger`
   - `triggerReason=...`
   - `triggerSource=heartbeat-directive`
   - `sourceEventId=...`
   - `sourceText=...`
6. 自动视频受冷却和上限保护，不能连续快速触发多段。
7. 服务端拥堵或 analysis queue 高水位时，Android 会进入自适应节流：
   - 图片采样间隔拉长或跳过本轮 still capture
   - 低信号音频延后补传
   - 自动视频 directive 被跳过

## 推荐准备

```bash
cd /Users/cedric/Documents/ClawSense
npm run build
npm test -- test/auto-video-trigger.test.ts
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./android/gradlew -p android :app:compileDebugKotlin --quiet
adb devices -l
```

如果没有授权 Android 真机，停止并报告：

```text
blocked: no authorized Android device connected
```

## 真机验证步骤

### 1. 安装 / 启动 / 配对

优先沿用现有 live 验收脚本：

```bash
cd /Users/cedric/Documents/ClawSense
npm run check:android-live:doctor
npm run check:android-live
```

确认手机首页：

- 感知服务运行中。
- 相机 / 麦克风 / 通知均授权。
- “自动视频 evidence 增强”默认关闭。

### 2. 默认关闭负向验证

保持自动视频关闭，播放或朗读一段包含触发词的内容，例如：

```text
看这里，这页 PPT 是重点，帮我看一下这段演示。
```

等待至少一个心跳周期，再检查：

```bash
scripts/local-openclaw.sh media-today
scripts/local-openclaw.sh openclaw clawsense queue-status
```

通过标准：

- 不应出现新的 `auto-video-trigger` video event。
- 如果出现，判为 `auto-video-disabled-bypass`。

### 3. 开启后正向验证

在 Android 首页打开“自动视频 evidence 增强”。

让手机真实采集一段触发语音或播放公开素材，建议内容包含：

```text
看这里，这个图很重要。重点是这页 PPT 上的发布节奏，帮我看一下这段。
```

等待 1 到 2 个心跳周期。观察 logcat：

```bash
adb logcat -d | grep -E "Auto video clip capture requested|Auto video upload succeeded|auto-video-trigger|Video upload succeeded"
```

通过标准：

- logcat 出现 `Auto video clip capture requested`。
- logcat 出现 `Auto video upload succeeded` 或至少视频上传进入补传队列。
- 正向自动视频报告必须用专用标记生成，避免覆盖 primary live 语音问答报告：

```bash
EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect
```

通过标准：

- `verdict.expectsAutoVideo=true`
- `verdict.autoVideoObserved=true`
- `verdict.autoVideoLiveReady=true`
- `logs.autoVideoUploadSucceeded > 0`
- `verdict.phaseReadyForRelease=false`，因为 auto-video-only 报告不能替代 primary 语音问答报告。

### 4. Host evidence 验证

检查媒体库和 evidence：

```bash
scripts/local-openclaw.sh media-today
scripts/local-openclaw.sh openclaw clawsense evidence --lookbackDays 1 --modality video --focus what_happened --question "刚才为什么自动录了这段视频？"
```

通过标准：

- `media-today` 能看到 `modality=video`。
- 相关 video 或 keyframe note 包含 `auto-video-trigger`。
- note 包含 `triggerReason`、`triggerSource=heartbeat-directive`、`sourceEventId`、`sourceText`。
- evidence 回答能说明“为什么录了这段”，而不是只描述画面。

### 5. 冷却 / 上限负向验证

在 10 分钟冷却内重复播放触发语句。

通过标准：

- 不应连续产生第二段自动视频。
- 如果连续触发，判为 `auto-video-cooldown-bypass`。

### 6. 队列拥堵 / 节流验证

优先使用真实高压场景验证，不要为了测试而清空用户媒体库。可以让手机在可控环境中连续采集音频 + 图片，同时观察服务端队列：

```bash
scripts/local-openclaw.sh openclaw clawsense queue-status
adb logcat -d -v time -s ClawSenseService:D ClawSenseAudio:D ClawSenseCamera:D '*:S' \
  | grep -E "Deferring still capture|Deferring low-signal audio|Skipping auto-video directive|上传遇到拥堵|analysis queue|server analysis queue"
```

通过标准：

- 如果服务端出现 503 / backpressure，Android 不能继续按正常频率刷图片。
- logcat 应出现 `Deferring still capture due to throttle` 或图片上传间隔明显变长。
- 低信号音频应出现 `Deferring low-signal audio clip due to throttle`，并进入待补传，而不是持续打服务端。
- 自动视频开启时，如果队列处于拥堵状态，应出现 `Skipping auto-video directive ... capture throttle`，不能继续自动录制大视频。
- 如果使用 live report 汇总器，报告里应看到：
  - `verdict.queueThrottleObserved=true`
  - `logs.stillCaptureDeferred > 0` 或 `logs.lowSignalAudioDeferred > 0`
  - 若存在自动视频 directive，则 `verdict.autoVideoThrottled=true`
- 如果无法稳定制造拥堵，不要伪造通过；优先报告真实压测未覆盖，再使用 debug-only throttle injection 辅助验证端侧逻辑。

当前 debug APK 已提供 debug-only throttle injection，可以在 debug APK 下补跑：

```bash
scripts/check-android-live.sh inject-throttle 60000 24
# 保持服务运行，制造一段低信号环境音或等待下一次 still capture。
scripts/check-android-live.sh collect
```

这只能证明 Android 节流逻辑和 live report 汇总器可用，不能替代真实服务端拥堵压测。报告中请标注 `queue throttle source=debug-injection`。

## 报告模板

请输出 markdown 报告，至少包含：

```md
# 自动视频触发验收报告

- 设备：
- APK 版本：
- OpenClaw / ClawSense 版本：
- 自动视频默认关闭：pass/fail
- 开启后自动触发：pass/fail
- Host video artifact：pass/fail
- note trigger metadata：pass/fail
- cooldown / limit：pass/fail/not-tested
- queue throttle：pass/fail/not-tested/needs-debug-injection
- queue-status：
- auto-video report：
- 失败原因：
- 建议下一步：
```

## 不要做

- 不要把手动 6 秒视频上传当作自动视频通过。
- 不要用模拟器替代物理 Android 真机。
- 不要为了触发自动视频而改服务端代码或清空用户媒体库。
- 不要在自动视频默认关闭时把“没有触发”判失败。
