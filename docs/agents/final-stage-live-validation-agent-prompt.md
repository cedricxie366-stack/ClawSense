# ClawSense 当前阶段最终真机验收 Agent Prompt

你是 ClawSense 的最终验收 agent。你的目标不是继续开发，而是用真实 Android 设备补齐当前阶段最后缺口，并产出可被 `npm run check:stage-final` 审计的报告。

## 背景

Host / fixture / video evidence 侧已经有 `npm run check:phase` 门禁。

当前仍未完成的是 Android live 端：

- 真实设备在线。
- 显式语音提问能进入 `/assistant/query`。
- 手机本地 TTS 能朗读答案。
- 真人确认朗读完整性和回答相关性。
- `停止朗读` 能触发。
- 手动 6 秒视频能真实上传。
- Host evidence 能看到 video/keyframe/transcript。

不要把模拟器结果当作最终通过。`check:stage-final` 默认要求物理 Android 设备；除非用户明确允许，否则不要设置 `ALLOW_EMULATOR_FINAL=1`。

## 准备

```bash
cd /Users/cedric/Documents/ClawSense

adb devices -l
npm run check:release
npm run check:phase
npm run check:android-live:doctor
npm run check:android-live:fixtures
npm run check:android-emulator:smoke
npm run check:stage-final:fixtures
npm run check:stage-final:doctor
npm run check:stage-final:index
```

如果 `adb devices -l` 没有授权设备，或 `npm run check:android-live:doctor` 输出 `status=waiting-for-device`，停止并报告：

```text
blocked: no authorized Android device connected
```

`check:android-live:doctor` 是非破坏性 preflight，只生成 `.local/android-live-reports/preflight-*.json`，不会安装 APK、不会启动服务。它必须至少确认：

- `currentPhase.ready=true`
- `app.apkExists=true`
- `localOpenClaw.openclawBinExists=true`
- `localOpenClaw.configExists=true`
- 只有设备缺口时，`status=waiting-for-device`
- 如果已有 live report，`latestAndroidLive.freshAgainstPhase=true`；否则必须重新跑 live 验收
- `latestAndroidLive` 只代表正常语音问答 / TTS / 视频报告，`latestAndroidNoArm` 代表无提问环境音报告；两者不能互相替代。
- 如果单独验证 Phase 9 自动视频，报告必须用 `EXPECT_AUTO_VIDEO=1 scripts/check-android-live.sh collect` 生成；它会进入 `latestAndroidAutoVideo`，不能替代 `latestAndroidLive`。
- 如果报告包含 `emulatorDebug.availableAvds`，只能把它作为安装 / 配对 / 服务启动调试线索；`emulatorDebug.canSatisfyFinalGate` 必须为 `false`，不能用模拟器报告替代物理旧手机验收。

`check:android-live:fixtures` 使用合成 logcat / Host evidence / package 输出验证 live report 汇总逻辑。它必须能证明 `voiceLoopObserved=true`、`ttsStatus=pass`、`audioRecheckAttempted=true`、`videoStatus=upload-observed`、`phaseReadyForRelease=true` 和 APK 版本字段可解析；同时必须证明缺少人工 TTS / 回答相关性确认、模拟器、HTTP 401 鉴权失败、缺少 audio recheck 诊断这些负向路径不会被误判。如果这条失败，先修 live report 汇总逻辑，不要进入真机验收。

`check:android-emulator:smoke` 只验证模拟器安装 / 配对 / 服务启动工具链，输出在 `.local/android-emulator-smoke-reports/`。它必须标记 `androidDevice.isEmulator=true`、`verdict.physicalAndroidDevice=false` 和 `verdict.phaseReadyForRelease=false`，并且不能被当成最终证据。如果这条失败，先看是否是 debug receiver、ADB reverse 或 APK 安装问题；如果这条通过，仍然必须继续做物理旧手机验收。

`check:stage-final:fixtures` 用合成报告验证最终门禁自身没有坏：fresh live 可通过，stale live、missing live、emulator live、缺人工 TTS / 回答相关性确认、HTTP 401 鉴权失败都必须失败。fixture 输出写入临时目录，不会污染 `.local/stage-final-reports` 的真实报告。如果这条失败，先修最终门禁脚本，不要进入真机验收。

`check:stage-final:index` 会生成 `.local/stage-final-reports/INDEX.md` / `INDEX.json`，用来区分真实报告和历史 fixture-smoke 报告。验收结论必须以 `latestReal` 为准，不能引用 fixture-smoke 报告作为通过证据。

`check:stage-final:doctor` 是非破坏性的最终状态汇总器，不会安装 APK、不会启动服务、不会生成新的 stage-final pass/fail 报告。它会同时读取最新 current-phase、primary Android live、no-arm ambient、stage-final index/preflight 和 emulator smoke 报告，并输出 `status` 与下一步命令。常见状态：

- `ready`：证据齐全，可以继续跑 `npm run check:stage-final`。
- `waiting-for-primary-live`：缺正常语音问答 / TTS / 手动视频报告。
- `waiting-for-no-arm-live`：缺无提问环境音污染报告。
- `waiting-for-auto-video-live`：设置了 `REQUIRE_AUTO_VIDEO_LIVE=1`，但缺自动视频报告。
- `primary-live-stale` / `no-arm-live-stale`：Android 报告早于最新 current-phase，需要重跑真机验收。
- `auto-video-live-stale`：自动视频报告早于最新 current-phase，需要重跑自动视频验收。
- `primary-live-needs-work` / `no-arm-live-needs-work` / `auto-video-live-needs-work`：已有报告但关键字段不满足。

如果你在一个可交互终端里操作真人真机，也可以用向导脚本减少漏命令风险：

```bash
npm run check:stage-final:live-guided
```

这个向导会串起 `check:android-live`、两轮显式提问、`stop-tts`、`capture-video`、primary collect、no-arm observe/collect 和最终 `check:stage-final`。它仍然会停下来要求真人说问题、播放环境音，并且只有你明确输入 `YES` 后才会设置 `HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1`。非交互环境下它会直接退出，不能替代本文件里的手动命令。

## 真机准备门禁

```bash
npm run check:android-live
```

期望：

- debug APK 安装成功。
- repo-local OpenClaw runtime 已同步。
- `adb reverse tcp:18789 tcp:18789` 成功。
- debug receiver 完成配对。
- debug receiver 从 App 进程内启动前台服务。

如果这一步失败，先查看 `.local/android-live-reports/android-live-*.log`，不要直接判产品失败；按失败原因分类：

- `pairing`
- `adb`
- `apk-install`
- `gateway`
- `permissions`
- `service-start`

## 验收 A：生成 primary live 报告

```bash
scripts/check-android-live.sh arm-query auto
```

真人对手机说：

```text
过去4小时我们聊了什么？
```

等待回答和播报结束，确保至少出现过一次完整 TTS completed。

只有在真人确认以下两点后，才允许设置 `HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1`：

- 手机确实朗读了答案，且没有明显截断到不可接受。
- 回答贴合问题，并且不是只描述图片或胡乱泛化。

同时检查最新 live report / logcat：

- 如果目标窗口里有新上传音频但回答仍依赖“过去4小时/刚才聊了什么”这类语音问题，`verdict.audioRecheckAttempted` 应为 `true`，或报告里必须解释“不需要 recheck，因为目标窗口已经有 transcript”。
- 如果 `verdict.audioRecheckAttempted=false` 且回答明显只看图片，判为 `audio-context-missing`，不要写 pass。
- 如果补扫成功，优先记录 `verdict.audioRecheckRefreshed=true` 和 `logs.assistantAudioRecheckRefreshed > 0`。

如果 TTS 失败但 UI 有文本答案，不要设置 `HUMAN_TTS_OK=1`，报告为 `tts-degraded-text-only`。

## 验收 B：会议模式、停止朗读和手动视频

```bash
PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting
```

真人说：

```text
刚才讨论的重点是什么？
```

让手机处于朗读中时执行停止朗读，然后追加手动 6 秒视频：

```bash
PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts
PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video
sleep 15
HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect
```

注意：`PRESERVE_LOGCAT=1` 是必须的。最终 primary live report 必须在同一份 logcat 里同时证明：

- 至少一轮完整语音问答和 TTS completed。
- 会议模式显式提问进入 `/assistant/query`。
- 停止朗读请求被客户端收到。
- 手动视频上传成功。
- Host evidence 能看到视频、关键帧和同组 transcript。

如果中途重新清空 logcat，会产生多份“各自只证明一部分”的报告，`check:stage-final` 会选择最新 primary report 并正确判失败。

通过标准：

- `logs.assistantQueryArmed > 0`
- `logs.assistantQueryCaptured > 0`
- `logs.assistantQuerySubmitting > 0`
- `logs.assistantQueryAnswered > 0`
- `verdict.voiceLoopObserved=true`
- `verdict.ttsStatus=pass`
- `verdict.humanTtsOk=true`
- `verdict.humanAnswerRelevant=true`
- `logs.assistantTtsStopRequested > 0`
- `verdict.stopTtsObserved=true`
- `logs.videoUploadSucceeded > 0`
- `verdict.videoStatus=upload-observed`
- `host.videoEvidenceGroups >= 1`
- `host.videoTranscriptSpans >= 1`
- `host.videoKeyframeDetails >= 1`

如果很难抓到朗读中窗口，记录为 `needs-retry`，不要硬判通过。注意：如果只有 `host-evidence-present`，说明 Host fixture evidence 存在，但没有证明 Android 真机视频上传成功；这不能算最终通过。

## 验收 D：环境音不污染显式提问

这一步专门验证“播放访谈 / 会议 / 视频音频，但没有点击问实时助手”时，客户端不会把环境音当作用户问题，也不会刷新 `最近显式提问`。

```bash
scripts/check-android-live.sh observe-ambient
```

然后播放一段 30-90 秒访谈 / 会议 / 视频音频，期间**不要**点击 `问实时助手`，也不要触发 `arm-query`。播放结束后执行：

```bash
EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect
```

通过标准：

- `verdict.expectsNoAssistantQuery=true`
- `verdict.noArmAmbientQueryClean=true`
- `verdict.noArmAmbientQueryPollution=false`
- `logs.assistantQueryArmed=0`
- `logs.assistantQueryCaptured=0`
- `logs.assistantQuerySubmitting=0`
- `logs.assistantQueryAnswered=0`

如果这一步出现 `noArmAmbientQueryPollution=true`，说明环境音仍被误当成显式提问，结论必须写 `failed: no-arm-ambient-query-pollution`，不要继续写 pass。

## 最终门禁

```bash
npm run check:stage-final
```

必须通过。失败时读取 `.local/stage-final-reports/stage-final-*.json` 的 `failure` / `failures`。

如果本轮要把 Phase 9 自动视频真机验收也作为 hard gate，请使用：

```bash
REQUIRE_AUTO_VIDEO_LIVE=1 npm run check:stage-final:doctor
REQUIRE_AUTO_VIDEO_LIVE=1 npm run check:stage-final
```

最终门禁现在要求两份 Android live 证据都新于当前 phase report：

- 正常语音问答 / TTS / 手动视频报告：`verdict.voiceLoopObserved=true` 且 `verdict.phaseReadyForRelease=true`
- 无提问环境音观察报告：`verdict.expectsNoAssistantQuery=true` 且 `verdict.noArmAmbientQueryClean=true`
- 如果设置 `REQUIRE_AUTO_VIDEO_LIVE=1`，还需要自动视频报告：`verdict.expectsAutoVideo=true` 且 `verdict.autoVideoLiveReady=true`

常见失败解释：

- `android_live_report_missing`：没有成功生成 Android live JSON。
- `android_no_arm_report_missing`：没有成功生成 `EXPECT_NO_ASSISTANT_QUERY=1` 的无提问环境音报告。
- `android_live.physicalAndroidDevice`：报告来自模拟器，不是物理旧手机。
- `android_live.voiceLoopObserved`：没有完整观察到 arm/capture/submit/answer。
- `android_live.ttsStatus:missing`：没有 TTS completed。
- `android_live.humanTtsOk`：真人没有确认朗读完整性。
- `android_live.humanAnswerRelevant`：真人没有确认回答相关性。
- `android_live.videoStatus:host-evidence-present`：只有 Host fixture 视频证据，没有 Android 真机视频上传。
- `android_live.stale:...`：Android live report 早于 current-phase report，需要重新跑真机验收。
- `android_no_arm.stale:...`：无提问环境音报告早于 current-phase report，需要重新跑 `observe-ambient`。
- `android_no_arm.noArmAmbientQueryClean`：无提问环境音窗口产生了 assistant query 日志，说明环境音污染显式提问。
- `android_auto_video_report_missing`：设置了 `REQUIRE_AUTO_VIDEO_LIVE=1`，但没有找到 `EXPECT_AUTO_VIDEO=1` 的自动视频报告。
- `android_auto_video.stale:...`：自动视频报告早于 current-phase report，需要重跑自动视频验收。
- `android_auto_video.autoVideoLiveReady`：自动视频报告存在，但没有证明自动触发、上传和 Host video evidence 成立。

## 输出报告

验收完成后新建：

```text
docs/agents/final-stage-live-validation-report-YYYY-MM-DD-HHMM.md
```

格式：

```markdown
# ClawSense Final Stage Live Validation Report

- 时间：
- 设备：
- 是否物理设备：
- App version：
- OpenClaw runtime：
- current-phase report：
- android-live report：
- android-no-arm report：
- android-auto-video report：
- stage-final report：
- stage-final index：
- App package：
- App versionName / versionCode：

## 结论

- pass / failed / blocked

## 通过项

- ...

## 失败项

- ...

## 关键证据

- voiceLoopObserved：
- ttsStatus：
- humanTtsOk：
- humanAnswerRelevant：
- stopTtsObserved：
- videoStatus：
- videoEvidenceGroups：
- videoTranscriptSpans：
- videoKeyframeDetails：
- noArmAmbientQueryClean：
- noArmAmbientQueryPollution：
- expectsAutoVideo：
- autoVideoObserved：
- autoVideoLiveReady：
- audioRecheckAttempted：
- audioRecheckRefreshed：
- androidPackage.versionName：
- androidPackage.versionCode：

## 下一步

- 最多 3 条。
```

如果 `npm run check:stage-final` 没通过，结论不能写 pass。
