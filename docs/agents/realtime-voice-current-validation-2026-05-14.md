# ClawSense 实时语音入口当前验收说明（2026-05-14）

> 用途：给真人验证 / 验证 Agent 使用。当前重点仍是 Phase 8：旧手机作为 OpenClaw 现实世界语音入口；如果顺手验视频，只验 Android 手动 6 秒短视频和 keyframe evidence。

## 当前必须验证的能力

1. 显式语音提问
- Android 点击 `问实时助手`
- 说一句短问题
- 手机显示 `最近显式提问`
- 手机 TTS 朗读 `answerSpokenText`
- 屏幕保留完整 `answerText`

2. 时间范围路由
- `过去4小时我们聊了什么？` 应命中 custom 4 小时时间窗
- `昨天发生了什么？` 应命中 day/yesterday 范围
- `刚才沟通的重点是什么？` 应自动提升到 last_5m/meeting

3. 音频证据优先
- 有 transcript 时，回答应优先引用音频内容，再结合图片/场景
- 不应“明明有音频却只描述照片”

4. 环境音不污染显式提问
- 播放一段视频/访谈但不点击 `问实时助手`，不应产生新的 `最近显式提问`
- 点击后如果没有说短问题、只有长视频声音，服务端应返回“这是环境声音，不像是你在提问”

5. 连续追问
- 先问：`过去4小时我们聊了什么？`
- 再问：`继续说`
- 再问：`简短点`
- 再问：`帮我整理成会议纪要`
- 后三轮应继承第一轮的 4 小时时间窗
- 会议纪要应返回 `actionIntent.type=draft_document` 和 `filePath`

6. TTS 控制
- `读全文` 应比普通摘要播报更完整
- 点击 `停止朗读` 应立即停止当前 Android 本地 TTS

## 验证前置检查

```bash
cd /Users/cedric/Documents/ClawSense

npm run check:release
npm run check:phase
npm run check:stage-final:doctor
npm run check:android-live -- help
npm run check:android-live:doctor

adb devices -l
adb reverse --list

scripts/local-openclaw.sh openclaw gateway status --json
scripts/local-openclaw.sh devices
scripts/local-openclaw.sh media-today
```

期望：

- Android 设备在线
- `check:phase` 成功；如果输出 `android.connectedDevices=0`，说明 host / fixture / video evidence 已过，但真机仍未接入
- 本地验证场景下有 `tcp:18789 tcp:18789`
- gateway running
- `devices` 中真实 Android 设备 `lastSeenAt/lastHeartbeatAt` 最近更新
- `media-today` 中能看到新 audio/image 事件；如验证视频，则应能看到 video 事件与 keyframe image 事件

`check:android-live:doctor` 是非破坏性 preflight，只生成 `.local/android-live-reports/preflight-*.json`，不会安装 APK 或启动服务。Host/fixture 已 ready 但没有真机时，它应显示 `status=waiting-for-device`，这时不要误判为代码失败。

如果 preflight 显示 `latestAndroidLive.freshAgainstPhase=false` 或 `status=stale-live-report`，说明旧 live JSON 早于当前 phase report，必须重新跑真机验收；不要用旧报告通过最终门禁。

## 真机自动化辅助脚本

当前真机验收不再建议手工拼接 ADB 命令，优先使用：

```bash
cd /Users/cedric/Documents/ClawSense

# 1. 构建 / 安装 debug APK，同步 repo-local OpenClaw，adb reverse，debug 配对并启动服务。
npm run check:android-live:doctor
npm run check:android-live

# 2. 触发 primary live 证据窗口。第一轮会清空 logcat，后续动作必须保留 logcat，
#    这样同一份报告才能同时证明语音问答、TTS、停止朗读和视频上传。
scripts/check-android-live.sh arm-query auto
# 真人说：过去4小时我们聊了什么？

# 3. 会议模式再测一轮，追加到同一个 primary report。
PRESERVE_LOGCAT=1 scripts/check-android-live.sh arm-query meeting
# 真人说：刚才讨论的重点是什么？

# 4. TTS 控制与手动视频，也追加到同一个 primary report。
PRESERVE_LOGCAT=1 scripts/check-android-live.sh stop-tts
PRESERVE_LOGCAT=1 scripts/check-android-live.sh capture-video
sleep 15
HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1 scripts/check-android-live.sh collect

# 5. 环境音不污染显式提问。这里会清空 logcat，生成单独 no-arm report。
scripts/check-android-live.sh observe-ambient
# 播放 30-90 秒访谈 / 视频 / 会议音频，不要点击“问实时助手”，然后：
EXPECT_NO_ASSISTANT_QUERY=1 scripts/check-android-live.sh collect

# 6. 最终阶段硬门槛：只有 current-phase 与 android-live 都通过才算当前阶段真正完成。
npm run check:stage-final
```

如果是在可交互终端里和真人一起验，也可以直接使用最终向导：

```bash
npm run check:stage-final:live-guided
```

向导只负责串命令，不会自动伪造人工确认；只有真人输入 `YES` 后才会设置 `HUMAN_TTS_OK=1 HUMAN_ANSWER_RELEVANT=1`。非交互环境会直接退出。

报告会写入：

```text
.local/android-live-reports/android-live-*.json
```

报告里的重点字段：

- `verdict.hostDeviceSeen / voiceLoopObserved / ttsStatus / videoStatus / phaseReadyForRelease`
- `verdict.physicalAndroidDevice`：最终验收默认必须为 `true`
- `logs.assistantQueryArmed / assistantQueryCaptured / assistantQuerySubmitting / assistantQueryAnswered`
- `logs.assistantTtsCompleted / assistantTtsFailed / assistantTtsStopRequested`
- `logs.longAssistantQueryRejected / continuedAmbientRejected`
- `verdict.expectsNoAssistantQuery / noArmAmbientQueryClean / noArmAmbientQueryPollution`
- `logs.audioUploadSucceeded / imageUploadSucceeded / videoUploadSucceeded`
- `host.mediaCounts`
- `host.videoEvidenceGroups / videoTranscriptSpans / videoKeyframeDetails`
- `ui.textSample`

注意：

- 这个脚本能证明 ADB、debug APK、配对、服务、日志和服务端 evidence；不能替代真人判断“手机是否真的读完整、是否听感正常”。
- `HUMAN_TTS_OK=1` 只能在真人确认“手机确实完整朗读到可接受程度”后设置。
- `HUMAN_ANSWER_RELEVANT=1` 只能在真人确认“回答确实贴合问题且引用了有效证据”后设置。
- `npm run check:stage-final:doctor` 是只读状态汇总入口。它不安装 APK、不启动服务，只告诉你当前缺 primary live、no-arm ambient，还是可以直接跑最终 gate。
- `npm run check:stage-final` 会要求最新 primary `android-live-*.json` 同时满足 voice loop、TTS、人工确认、停止朗读、手动视频上传和 host evidence；还会要求另一份 `EXPECT_NO_ASSISTANT_QUERY=1` no-arm report 证明环境音没有污染显式提问。没有 primary live report 时会明确失败为 `android_live_report_missing`，没有 no-arm report 时会明确失败为 `android_no_arm_report_missing`。
- 如果没有在线设备，脚本会明确失败为 `no authorized Android device connected`，这不是代码侧失败。
- 如果有多台设备，设置 `ANDROID_SERIAL=<serial>` 后再运行。
- `EXPECT_NO_ASSISTANT_QUERY=1` 只用于“没有点击问实时助手”的环境音观察窗口；如果这时出现任何 `Assistant query armed/captured/submitting/answered`，报告会标记 `noArmAmbientQueryPollution=true`，应判为环境音污染失败。

## 接口快速检查

```bash
cd /Users/cedric/Documents/ClawSense

TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('.local/openclaw/state/openclaw.json','utf8')).gateway.auth.token")
Q=$(python3 - <<'PY'
import urllib.parse
print(urllib.parse.quote('过去4个小时我们聊了什么？'))
PY
)

curl -sS \
  "http://127.0.0.1:18789/api/clawsense/recent-context?windowHint=last_60s&modeHint=auto&question=$Q" \
  -H "Authorization: Bearer $TOKEN" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({ok:j.ok,windowHint:j.windowHint,modeUsed:j.modeUsed,label:j.timeRange?.label,counts:j.counts,transcripts:j.recentTranscriptSpans?.length,sceneSummary:(j.sceneSummary||"").slice(0,160)},null,2));})'
```

期望：

- `ok=true`
- `windowHint=custom`
- `label` 是约 4 小时时间窗
- 若这 4 小时内有录音，`transcripts > 0`

## Android 日志观察

```bash
adb logcat -c
adb logcat | grep -E "Assistant query|Assistant TTS|Audio upload succeeded|Image upload succeeded|Rejecting long assistant query|rawQueryLen|sttRewrite|audioRecheck|HTTP 401|HTTP 503"
```

重点看：

- 短问题触发时应出现 `Assistant query submitting` 和 `Assistant query answered`
- 如果问题是 `过去4小时我们聊了什么？`、`刚才讨论的重点是什么？` 且目标时间窗里还有未转写音频，`Assistant query answered` 里应出现 `audioRecheckAttempted=true`；如果补扫成功，进一步出现 `audioRecheckRefreshed=true` 和 `audioRecheckTranscripts>0`
- 正常播报时应出现 `Assistant TTS completed`
- 点击停止时应出现 `Assistant TTS stop requested`
- 长环境音被拒绝时应出现 `Rejecting long assistant query candidate`
- 不应频繁出现 `HTTP 401` / `HTTP 503`

## 身份标注验收

先看当前候选：

```bash
cd /Users/cedric/Documents/ClawSense

scripts/local-openclaw.sh openclaw clawsense annotate-suggestions today \
  --question "今天办公期间有哪些人物线索需要补标注？"
```

期望：

- 不应把普通名词 / 连词当成人物候选，例如 `构造`、`纸箱`、`还是`
- 如果输出 `speakers`，说明当前可走 speaker 标注路径
- `people=[]` 不是失败，只表示没有高质量 personRef 候选

如果真人能确认某个 speaker 身份，把输出里的 `commandTemplate` 中的 `李三 / 同事` 改成真实身份后执行，例如：

```bash
scripts/local-openclaw.sh openclaw clawsense annotate-speaker \
  "speaker:audio-session::<deviceId>::<sessionId>:1" \
  "真实姓名" \
  --relationship "同事" \
  --windowId "audio-session::<deviceId>::<sessionId>"

scripts/local-openclaw.sh openclaw clawsense acceptance 7
```

期望：

- `annotation-and-stability.evidence.relevantIdentityAnnotations >= 1`
- 办公素材相关时，`office-recap.evidence.confirmedIdentities >= 1`
- 后续问“这个人之前出现过什么 / speaker_1 刚才说了什么”时，回答应使用实名或关系。

## 当前已由 Codex 自测通过的链路

- `npm test -- test/realtime-assistant.test.ts`：28 tests passed
- `npm test -- test/assistant-tool.test.ts`：30 tests passed
- `npm test -- test/review-engine.test.ts`：40 tests passed
- `npm run check`：passed
- `npm test`：195 tests passed
- `npm run check:release`：passed，确认 npm 包名为 `clawsense@0.1.0`，且不包含开发-only 目录
- `npm run check:phase`：
  - `phaseState=ready-to-close`
  - `passedCriteria=5/5`
  - `videoEvidence.transcriptReadyWindows=1`
  - `videoEvidence.transcriptSpans=3`
  - `videoEvidence.keyframeDetails=3`
  - 当前剩余最终缺口不是 Host evidence，而是真实物理 Android 的 primary live report + no-arm ambient report。
- `openclaw clawsense annotate-suggestions today --question "今天办公期间有哪些人物线索需要补标注？"`：
  - 不应再把“构造 / 纸箱 / 还是”输出为人物候选
  - 当前真实数据可能只输出 speaker 建议，这是允许的
  - 如果用户知道 speaker 身份，可执行对应 `annotate-speaker` 命令后复跑 acceptance
- 合成语音 `/assistant/query`：
  - `过去四个小时我们聊了什么`：命中 custom 4 小时时间窗，回答引用音频主线
  - 长环境访谈音频：`queryText=""`，不会作为显式提问
  - `继续说 / 简短点 / 帮我整理成会议纪要`：继承上一轮 4 小时时间窗
  - `draft_document`：已确认 markdown 草稿落盘

## 2026-05-31 当前代码侧复核快照

验证 agent 已完成只读复核，结论如下：

- `npm test`：10 个测试文件、195 tests passed。
- `npm run check:release`：通过，覆盖 build、tests、shell syntax、`npm pack --dry-run`。
- repo-local `acceptance`：`5/5 ready-to-close`，`blockers=[]`。
- 视频 evidence：`hostModelVideoMode=keyframes`，`playableVideoArtifacts=1`，`videoRequestGroups=1`，`keyframeEvents=3`。
- 视频问题 evidence：包含 `audioCoverage.transcriptReadyWindows=1`、`videoEvidenceGroups`、3 段 `transcriptSpans`、关键帧 caption、OCR hints 和 `linkedVideoUrl`。
- Android debug build：`assembleDebug` 通过。
- `npm run check:phase`：通过；报告摘要为 `phaseState=ready-to-close`、`passedCriteria=5/5`、`hostModelVideoMode=keyframes`、`videoEvidence.transcriptReadyWindows=1`、`keyframeDetails=3`、`android.connectedDevices=0`。

当前尚未通过真人 / 真机证明的项目：

- `adb devices -l` 当前无设备。
- 显式语音提问能否在真机上稳定进入 `assistant/query`。
- 手机本地 TTS 是否完整朗读 `answerSpokenText`。
- `读全文` 是否比普通摘要播报更完整。
- `停止朗读` 是否立即停止 Android 本地 TTS。
- 播放环境视频但不点击 `问实时助手` 时，是否不会生成新的 `最近显式提问`。
- 对应自动报告字段：`verdict.noArmAmbientQueryClean=true`、`verdict.noArmAmbientQueryPollution=false`。
- Android 手动 6 秒视频是否能在真实设备上完成上传、入库，并在 evidence 里回链 keyframes / transcript。
- primary live report 与 no-arm ambient report 是否都新于最新 current-phase report，并通过 `npm run check:stage-final`。

因此验证 agent 下一轮只需要补真机端，不需要重复证明 host fixture / release gate。

## 报告格式

验证后请记录：

- 测试时间：
- Android 设备名 / appVersion：
- OpenClaw 运行位置：本地 / 云端
- 采集素材类型：办公 / 课堂 / 视频访谈 / 其他
- 通过项：
- 失败项：
- 关键截图：
- 关键 logcat：
- `media-today` 事件数量：
- `assistant/query` 最近一次回答摘要：
- 是否可以判定 Phase 8 语音入口可验收：
