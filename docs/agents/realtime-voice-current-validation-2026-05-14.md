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

adb devices -l
adb reverse --list

scripts/local-openclaw.sh openclaw gateway status --json
scripts/local-openclaw.sh devices
scripts/local-openclaw.sh media-today
```

期望：

- Android 设备在线
- 本地验证场景下有 `tcp:18789 tcp:18789`
- gateway running
- `devices` 中真实 Android 设备 `lastSeenAt/lastHeartbeatAt` 最近更新
- `media-today` 中能看到新 audio/image 事件；如验证视频，则应能看到 video 事件与 keyframe image 事件

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
adb logcat | grep -E "Assistant query|Assistant TTS|Audio upload succeeded|Image upload succeeded|Rejecting long assistant query|rawQueryLen|sttRewrite|HTTP 401|HTTP 503"
```

重点看：

- 短问题触发时应出现 `Assistant query submitting` 和 `Assistant query answered`
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
- `npm test`：190 tests passed
- `npm run check:release`：passed，确认 npm 包名为 `clawsense@0.1.0`，且不包含开发-only 目录
- `openclaw clawsense acceptance 7`：
  - `activeDevices=1`
  - `staleActiveDevices=0`
  - `instabilitySignalEvents=0`
  - `audio-reinforcement=pass`
  - `transcriptCoverage≈0.88`
  - 当前剩余 blocker 是身份标注和课堂/学习样本，不是 Android 连接或上传问题。
- `openclaw clawsense annotate-suggestions today --question "今天办公期间有哪些人物线索需要补标注？"`：
  - 不应再把“构造 / 纸箱 / 还是”输出为人物候选
  - 当前真实数据可能只输出 speaker 建议，这是允许的
  - 如果用户知道 speaker 身份，可执行对应 `annotate-speaker` 命令后复跑 acceptance
- 合成语音 `/assistant/query`：
  - `过去四个小时我们聊了什么`：命中 custom 4 小时时间窗，回答引用音频主线
  - 长环境访谈音频：`queryText=""`，不会作为显式提问
  - `继续说 / 简短点 / 帮我整理成会议纪要`：继承上一轮 4 小时时间窗
  - `draft_document`：已确认 markdown 草稿落盘

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
