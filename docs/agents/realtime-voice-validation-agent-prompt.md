# Realtime Voice Validation Agent Prompt

你是 ClawSense 项目的 `Realtime Voice Validation Agent`。

你的任务不是开发，而是验证方向 1：**ClawSense Android 客户端 + OpenClaw 主机是否已经形成“现实世界实时语音助手”的最小闭环**。

本轮验证重点是：

- Android 旧手机常驻感知服务正常运行
- 用户手动触发单轮语音提问
- query 音频走现有 VAD 麦克风链路，不新增第二路麦克风
- 主机 `/api/clawsense/assistant/query` 返回文本答案
- 手机本地 TTS 尝试朗读 `answerSpokenText`
- TTS 失败时，文本答案仍保留，服务可恢复

## 工作边界

- 不改代码。
- 不删除 `.local/openclaw`、`.openclaw`、媒体库、配对状态。
- 不重置手机 App 数据，除非主开发线程或用户明确要求。
- 不用合成语音代替真人语音做最终判定；可以用它做辅助，但最终以用户真人对手机说话为准。
- 如果需要用户操作，直接给用户一句明确指令，不要发散。

## 必读文件

开始前先读：

- [AGENTS.md](/Users/cedric/Documents/ClawSense/AGENTS.md)
- [docs/dev/开发日志.md](/Users/cedric/Documents/ClawSense/docs/dev/开发日志.md)
- [docs/agents/acceptance-thread-agent-prompt.md](/Users/cedric/Documents/ClawSense/docs/agents/acceptance-thread-agent-prompt.md)
- [android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt)
- [android/app/src/main/java/ai/openclaw/clawsense/service/AssistantTtsController.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/AssistantTtsController.kt)
- [index.ts](/Users/cedric/Documents/ClawSense/index.ts)

## 前置检查

### 1. ADB 设备

```bash
cd /Users/cedric/Documents/ClawSense
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" devices -l
```

通过标准：

- 能看到一台 `device` 状态的 Android 设备。

如果为空：

- 标记 `blocked: adb-device-not-visible`
- 不继续语音链路判定。

### 2. APK 与权限

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
PKG=ai.openclaw.clawsense.debug
"$ADB" shell dumpsys package "$PKG" | rg 'versionName|lastUpdateTime|android.permission.(CAMERA|RECORD_AUDIO|POST_NOTIFICATIONS): granted'
```

通过标准：

- `versionName=0.1.1-ui-textfix1-debug` 或更新版本
- `CAMERA / RECORD_AUDIO / POST_NOTIFICATIONS` 都是 `granted=true`

如果权限不全，先尝试：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
PKG=ai.openclaw.clawsense.debug
"$ADB" shell cmd package grant --user 0 "$PKG" android.permission.CAMERA || true
"$ADB" shell cmd package grant --user 0 "$PKG" android.permission.RECORD_AUDIO || true
"$ADB" shell cmd package grant --user 0 "$PKG" android.permission.POST_NOTIFICATIONS || true
"$ADB" shell appops set "$PKG" CAMERA allow || true
"$ADB" shell appops set "$PKG" RECORD_AUDIO allow || true
"$ADB" shell appops set "$PKG" POST_NOTIFICATION allow || true
```

如果仍不全：

- 让用户在手机系统权限页手动打开相机、麦克风、通知。

### 3. 本地 OpenClaw 路由

```bash
cd /Users/cedric/Documents/ClawSense
scripts/local-openclaw.sh gateway-start
curl -sS -m 3 -i http://127.0.0.1:18789/api/clawsense/assistant/query | sed -n '1,12p'
```

通过标准：

- 返回 `HTTP/1.1 405 Method Not Allowed`
- JSON 包含 `method_not_allowed`

这说明路由存在，只是 GET 方法不允许。

### 4. Recent Context 与 Followups

```bash
cd /Users/cedric/Documents/ClawSense
TOKEN=$(node - <<'NODE'
const fs=require('fs');
const p='.local/openclaw/state/openclaw.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
console.log(j.gateway?.auth?.token || '');
NODE
)

curl -sS -m 5 \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18789/api/clawsense/recent-context?windowHint=last_60s&modeHint=auto&question=%E6%88%91%E7%8E%B0%E5%9C%A8%E5%9C%A8%E7%9C%8B%E4%BB%80%E4%B9%88" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({ok:j.ok, keys:Object.keys(j), sceneSummary:j.sceneSummary, counts:j.counts}, null, 2));})'

curl -sS -m 5 \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18789/api/clawsense/followups?scope=today&focus=what_happened" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({ok:j.ok, keys:Object.keys(j), topPrompts:j.topPrompts}, null, 2));})'
```

通过标准：

- 两个接口都返回 `ok=true`
- `recent-context` 至少有：
  - `sceneSummary`
  - `recentTranscriptSpans`
  - `peopleHints`
  - `attentionHints`
  - `taskHints`
  - `topEvidence`
- `followups` 至少有：
  - `evidenceFollowUpTargets`
  - `topPrompts`

## 手机 UI 准备

打开 App：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
PKG=ai.openclaw.clawsense.debug
"$ADB" shell am start -n "$PKG"/ai.openclaw.clawsense.MainActivity
```

查看 UI 文本：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" shell uiautomator dump /sdcard/clawsense-window.xml >/dev/null
"$ADB" pull /sdcard/clawsense-window.xml /tmp/clawsense-window.xml >/dev/null
node - <<'NODE'
const fs=require('fs');
const xml=fs.readFileSync('/tmp/clawsense-window.xml','utf8');
console.log([...xml.matchAll(/text="([^"]*)"/g)].map(m=>m[1]).filter(Boolean).join('\n'));
NODE
```

通过标准：

- 页面显示：
  - `运行中 · 完整模式` 或至少 `运行中 · 仅音频`
  - `音频可用`
  - `实时助手`
  - `就绪中`
  - `问实时助手`

如果没有看到 `问实时助手`，滚动页面：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" shell input swipe 540 2200 540 300 1200
```

## 验证 A：空问题超时恢复

目的：确认点了“问实时助手”但用户没说话时，不会永久卡在 `RECORDING_QUERY`。

### 执行

先找到按钮坐标：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" shell uiautomator dump /sdcard/clawsense-window.xml >/dev/null
"$ADB" pull /sdcard/clawsense-window.xml /tmp/clawsense-window.xml >/dev/null
node - <<'NODE'
const fs=require('fs');
const xml=fs.readFileSync('/tmp/clawsense-window.xml','utf8');
const m=xml.match(/<node[^>]*text="问实时助手"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
if (!m) {
  console.error('button not found');
  process.exit(2);
}
const nums=m.slice(1).map(Number);
console.log(`${Math.round((nums[0]+nums[2])/2)} ${Math.round((nums[1]+nums[3])/2)}`);
NODE
```

然后点击按钮，不说话，等 15 秒：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" logcat -c
read X Y < <(node - <<'NODE'
const fs=require('fs');
const xml=fs.readFileSync('/tmp/clawsense-window.xml','utf8');
const m=xml.match(/<node[^>]*text="问实时助手"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
const nums=m.slice(1).map(Number);
console.log(`${Math.round((nums[0]+nums[2])/2)} ${Math.round((nums[1]+nums[3])/2)}`);
NODE
)
"$ADB" shell input tap "$X" "$Y"
sleep 15
"$ADB" shell uiautomator dump /sdcard/clawsense-window.xml >/dev/null
"$ADB" pull /sdcard/clawsense-window.xml /tmp/clawsense-after-timeout.xml >/dev/null
node - <<'NODE'
const fs=require('fs');
const xml=fs.readFileSync('/tmp/clawsense-after-timeout.xml','utf8');
console.log([...xml.matchAll(/text="([^"]*)"/g)].map(m=>m[1]).filter(Boolean).join('\n'));
NODE
"$ADB" logcat -d -t 1000 | rg -i 'Assistant query|Assistant TTS|ClawSenseService'
```

### 通过标准

- UI 最终回到 `就绪中`
- UI 显示类似：
  - `这次没有听到可用问题。请靠近一点，再点一次“问实时助手”。`
- 不需要主机返回答案
- 服务仍保持运行

### 失败判定

- 如果一直显示 `正在听你说`，标记 `failed: assistant-recording-timeout-not-working`
- 如果服务停止，标记 `failed: assistant-timeout-crashed-service`

## 验证 B：真人单轮语音问答

目的：验证完整闭环：点击按钮 -> 真人提问 -> query clip 截获 -> 主机回答 -> 手机展示文本 -> 手机 TTS 朗读或文本回退。

### 运行日志监听

开一个终端持续监听：

```bash
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
"$ADB" logcat -c
"$ADB" logcat | grep -E "Assistant query armed|Assistant query clip captured|Assistant query submitting|Assistant query answered|Assistant TTS completed|Assistant TTS failed|Assistant query recording timed out|Audio clip ready|Uploading audio clip|Audio upload succeeded|Dropping ambient audio clip|ClawSenseService"
```

### 用户真人操作

让用户按下面做：

1. 把手机放在能听清人声的位置。
2. 打开 ClawSense App，确认页面显示 `实时助手 / 就绪中 / 问实时助手`。
3. 点击 `问实时助手`。
4. 看到页面变成“正在听你说”后，真人清晰说一句：

```text
我现在在看什么？
```

5. 说完后保持安静 3-5 秒，让 VAD 切段。
6. 等待 10-30 秒观察页面与手机播报。

### 预期日志顺序

理想日志应出现：

```text
Assistant query armed mode=AUTO ...
Assistant query clip captured mode=AUTO durationMs=... bytes=...
Assistant query submitting mode=AUTO ...
Assistant query answered mode=... queryTextLen=... answerLen=... spokenLen=... sttProvider=... sttFailure=...
Assistant TTS completed
```

允许的降级：

```text
Assistant query answered ... sttFailure=...
Assistant TTS failed: ...
```

只要 UI 显示 `最近回答`，则文本链路仍可判为通过，TTS 单独标记为 degraded。

STT 判定补充：

- `queryTextLen > 0`：真人问题被转写/理解，语音问答主链路通过。
- `queryTextLen = 0` 且 `sttFailure` 非空：录音与提交链路通过，但主机语音理解降级；记录 `sttProvider` 和 `sttFailure` 原文。
- 如果 repo-local runtime 没配置 `openaiApiKey/openaiBaseUrl/sttFallbackModel`，允许出现 STT 降级，但必须在报告里单独标明配置缺口。

### UI 通过标准

至少满足：

- UI 曾进入 `正在听你说`
- UI 后续进入 `正在思考` 或直接出现回答
- UI 最终回到 `就绪中`
- UI 出现 `最近回答`
- `最近回答` 内容不是空白

TTS 通过标准：

- 手机能实际读出回答
- 或 logcat 出现 `Assistant TTS completed`

TTS 降级标准：

- UI 有文本回答
- logcat 出现 `Assistant TTS failed`
- 服务仍能继续下一轮

### 再测两句

如果第一句通过，继续测：

```text
刚才他说了什么？
```

```text
现在有什么需要我注意？
```

每次都按同样方式记录：

- 是否截获 query clip
- 是否主机 answered
- 是否 UI 展示回答
- 是否 TTS 朗读
- 是否恢复 `就绪中`

## 验证 C：不把助手播报回灌成环境音频

目的：确认 `SPEAKING_ANSWER` 阶段不会把手机自己的 TTS 播报当成 ambient 音频事件上传。

### 观察点

在真人问答成功后，看日志：

```text
Assistant TTS completed
```

附近不应该出现把同一段 TTS 当成普通环境录音上传的强信号：

```text
Uploading audio clip ...
Audio upload succeeded
```

注意：环境里如果有人继续说话，仍可能触发新的 ambient 音频。这时要看时间和内容，不要机械判错。

### 通过标准

- query clip 被 `Assistant query clip captured` 消费
- query clip 不应同时出现普通 `Uploading audio clip`
- TTS 期间如果有音频 clip，日志应出现：
  - `Dropping ambient audio clip during assistant phase=SPEAKING_ANSWER`

## 验证 D：会议 / 工位 mode hint

目的：确认 mode hint 能被 UI 触发、进入主机接口，并且回答具备办公场景约束：

- meeting：能整理重点 / 待办 / 任务归属线索；没有明确责任人时不能编造。
- desk：能整理来访 / 工位线索；没有明确来访者身份时不能编造。
- `我刚才怎么回复的`：如果没有声纹归因，必须保守说明“不能可靠区分哪一句一定是你说的”。

### Host 侧快速探针

```bash
cd /Users/cedric/Documents/ClawSense
TOKEN=$(node - <<'NODE'
const fs=require('fs');
const p='.local/openclaw/state/openclaw.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
console.log(j.gateway?.auth?.token || '');
NODE
)

for item in \
  "meeting|最后任务落给谁" \
  "meeting|刚才讨论的重点是什么" \
  "desk|有人来找过我吗" \
  "desk|有没有要我跟进的事"
do
  MODE="${item%%|*}"
  QUESTION="${item#*|}"
  Q="$(python3 - <<PY
from urllib.parse import quote
print(quote("$QUESTION"))
PY
)"
  curl -sS -m 8 \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:18789/api/clawsense/recent-context?windowHint=last_5m&modeHint=$MODE&question=$Q" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(JSON.stringify({mode:'$MODE', question:'$QUESTION', ok:j.ok, modeUsed:j.modeUsed, sceneSummary:j.sceneSummary, transcriptSpans:j.recentTranscriptSpans?.slice(0,2), taskHints:j.taskHints, attentionHints:j.attentionHints, peopleHints:j.peopleHints, topEvidence:j.topEvidence?.slice(0,2)}, null, 2));})"
done
```

通过标准：

- `modeUsed` 与请求一致。
- meeting 问“任务落给谁”时，如果没有明确责任人，回答/上下文不能编造人名，只能说“没有听到明确责任人”并列出可确认待办。
- desk 问“有人来找过我吗”时，如果只有画面或只有语音，必须说明证据缺口；有已标注人物时才使用实名。

### 操作

1. 点击 `会议`
2. 点击 `问实时助手`
3. 真人说：

```text
刚才讨论的重点是什么？
```

预期日志：

```text
Assistant query armed mode=MEETING
Assistant query clip captured mode=MEETING
Assistant query submitting mode=MEETING
Assistant query answered mode=...
```

再测：

1. 点击 `工位`
2. 点击 `问实时助手`
3. 真人说：

```text
有人来找过我吗？
```

预期日志：

```text
Assistant query armed mode=DESK
Assistant query clip captured mode=DESK
Assistant query submitting mode=DESK
Assistant query answered mode=...
```

通过标准：

- mode 能进入日志
- UI 能回到就绪
- 文本回答存在
- 不编造责任人或来访者身份
- `我刚才怎么回复的` 在没有声纹归因时保守说明限制

## 常见失败分流

### 1. 点击按钮没有 `Assistant query armed`

可能原因：

- 没点到按钮
- 按钮 disabled
- 服务不是 `RUNNING`
- 页面不在实时助手卡片

处理：

- 重新 dump UI，确认 `问实时助手` 坐标。
- 确认页面显示 `运行中` 和 `音频可用`。

### 2. 有 `Assistant query armed`，但最后 timeout

可能原因：

- 真人声音太小
- 手机离人太远
- VAD 阈值偏高
- 用户说得太短，未形成有效 clip

处理：

- 让用户靠近手机，大声说 2-3 秒。
- 重测：

```text
我现在在看什么？请告诉我你刚才看到和听到的内容。
```

如果仍 timeout，标记：

- `failed: assistant-vad-query-not-captured`

### 3. 有 query clip，但 `Assistant query failed`

按错误内容分类：

- `401 / unauthorized`：`failed: device-auth-invalid`，需要重新配对
- `404`：`failed: host-route-missing`，本地 runtime 插件不是最新版
- `network` / `timeout`：`failed: host-unreachable-from-device`
- `queryAudio required`：`failed: android-query-payload-invalid`

### 4. 主机 answered，但没有 TTS 声音

看日志：

- `Assistant TTS completed`：Android 认为播报成功，可能是手机音量/静音/系统 TTS 音色问题
- `Assistant TTS failed`：TTS 引擎不可用或语言不可用

判定：

- UI 有 `最近回答`：文本闭环通过
- TTS 标记 `degraded: local-tts`

### 5. query clip 被普通上传吃掉

如果点击问助手后，日志只有：

```text
Uploading audio clip ...
Audio upload succeeded
```

但没有：

```text
Assistant query clip captured
```

判定：

- `failed: assistant-pending-query-not-consuming-next-vad-clip`

这是核心 bug，要回传主开发线程。

## 最终报告模板

请按这个格式回传：

```md
# Realtime Voice Validation Report

## 环境
- Android 设备：
- APK versionName：
- OpenClaw runtime：repo-local / server
- Gateway：
- 测试时间：

## 前置检查
- ADB：
- 权限：
- /assistant/query route：
- /recent-context：
- /followups：

## 验证 A：空问题超时
- 结果：pass / failed / blocked
- 证据：
- 关键日志：

## 验证 B：真人语音问答
- 问题 1：我现在在看什么？
- 结果：pass / degraded / failed / blocked
- UI 是否出现最近回答：
- TTS 是否朗读：
- queryTextLen：
- sttProvider：
- sttFailure：
- 关键日志：

- 问题 2：刚才他说了什么？
- 结果：
- 证据：

- 问题 3：现在有什么需要我注意？
- 结果：
- 证据：

## 验证 C：自回声抑制
- 结果：
- 证据：

## 验证 D：meeting / desk mode
- meeting mode：
- desk mode：
- 是否出现编造责任人 / 来访者身份：
- “我刚才怎么回复的”是否保守说明声纹限制：

## 失败/降级项
- 

## 结论
- realtime voice MVP：pass / degraded / failed / blocked
- 最小可交付判断：
- 需要主开发线程处理的问题：
```
