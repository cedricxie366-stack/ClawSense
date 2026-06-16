# ClawSense 实时助手显式提问 ASR 故障诊断（对应 2026-06-11 交接备忘录）

诊断对象：`docs/notes/realtime-assistant-asr-handoff-2026-06-11.md`
诊断方式：通读 Android 录音链路与 Host query ASR 链路全部相关代码，逐条核对备忘录中的方向 A–E。

## 核心结论（一句话）

录音链路和 ASR API 都在工作；**问题出在 Host 侧 `resolveAssistantQueryText()` 的硬编码白名单守门员**。日志里那次失败，本地 SenseVoice 和 DashScope 两路 ASR 都产出了约 8 个字的文本，全部被 resolver 以 `ambient_transcript_no_question` 拒杀。显式按钮模式下，任何轻微误听（丢首字、同音字）都会导致 regex 白名单全军覆没。

## 关键日志逐字段解码

```
sttFailure=runtime_stt_empty|query_time_local_asr_unusable_query|query_time_local_asr_empty|query_time_asr_unusable_query
sttRewrite=ambient_transcript_no_question rawQueryLen=8
```

| 字段 | 实际含义 |
|---|---|
| `runtime_stt_empty` | OpenClaw runtime STT 没出文本 |
| `query_time_local_asr_unusable_query` | **SenseVoice 产出了文本**，被 resolver 拒掉 |
| `query_time_local_asr_empty` | 误报。这是 `index.ts` 的记账 bug（见下），SenseVoice 并不是 empty |
| `query_time_asr_unusable_query` | **DashScope 也产出了文本**，同样被 resolver 拒掉 |
| `rawQueryLen=8` | 被拒的转写约 8 个字符，与一句短问句长度吻合 |

记账 bug 位置：`index.ts:288-292`。当 local ASR 有 transcript 但被判 unusable 时，`analysisFailureReason` 为 `undefined`，第 292 行 `?? "query_time_local_asr_empty"` 又补推了一个 "empty"，造成"local ASR 没听到"的假象，干扰了此前几轮排查。

**推理**：两路相互独立的 ASR 引擎在同一段 WAV 上都听到了约 8 个字 → 麦克风、VAD 切片、WAV 编码、上传、ASR API 调用全部工作 → 唯一把 queryText 清零的环节是 resolver。

## 方向 A–E 逐条裁决

### 方向 E：resolver 过度严格 —— ✅ 主根因（置信度最高）

`src/realtime-assistant.ts:963` 的 `hasSupportedQuestionCue()` 是一个巨型 regex 白名单。对显式提问的判定流程（`resolveAssistantQueryText`，第 123 行）是：**不命中白名单 → 直接清零**。

致命点：用户已经按了"问实时助手"按钮，先验概率压倒性地是"这是一句提问"，却仍要求 ASR 转写逐字命中白名单。短中文句的 ASR 误差模式恰好都能绕过 regex：

- 丢首字（VAD 起始截断）："刚才发生了什么" → "发生了什么" → `刚(?:才|刚).*发生` 不命中 → 拒
- 同音字误听："刚才**花**生了什么" → 拒
- 语气词变体："刚才发生啥了" → 拒（白名单没有"啥"）

备忘录提到"已加了'刚才发生了什么'规则但真人仍不通"——已核实 `dist/src/realtime-assistant.js`（构建时间晚于源码）确实包含新规则，部署不是问题；说明真人那次的 raw 转写**又是另一个不在白名单里的变体**。这正是白名单方案不可收敛的证明：每修一个变体，下一个变体继续漏。

### 方向 A：复用环境 VAD 做 query recorder —— ✅ 真实设计问题，次根因

确认了备忘录的怀疑，具体机制：

1. **首音节丢失**：`AndroidAudioSensorHal.kt:91-107`，按钮触发的 boundary reset 会清空 pre-roll 缓冲；之后 VAD 激活需要连续 2 帧（每帧 2048 样本 ≈ 128ms）RMS ≥ 0.012。用户按完按钮立刻开口时，"刚才"两个字的前半很容易不在 clip 里——直接喂出上面"丢首字"的 ASR 输入。
2. **延迟大**：必须等 2.4s 尾静音（`silenceTimeoutMs=2400`）才 flush，外加 15s+2.5s 超时窗口，体验差且容易把后续环境音卷进来。
3. **Android 侧还有一排独立的拒绝分支**（`SensorForegroundService.kt:479-551`）：expired、pre-armed、too long（>18s）、continued ambient。背景有持续人声/视频时，这些分支会在上传前就把 query 杀掉。

但注意：观测到的那条日志 `durationMs=4353 voicedMs=1664` 说明**那次 clip 是录到了的**（1.6 秒人声与一句短问句吻合），且成功上传并被两路 ASR 转出文本。所以 A 是放大器和体验问题，不是当前"0 命中"的直接原因。

### 方向 D：SenseVoice 配置 —— ⚠️ 加剧因素

`src/config.ts:21` 默认 `localAsrLanguage: "auto"`。短中文命令在 auto 模式下误听率更高，建议强制 `zh`。另外 `local-asr.ts:153` 开了 ITN 而 DashScope 路关了 `enable_itn`，两路文本形态不一致（数字、标点），会让 regex 白名单的命中更加随机——再次说明白名单方案脆弱。

### 方向 B：WAV / AudioRecord 参数 —— ❌ 基本排除（格式层面）

`WavEncoder.kt` 逐字段核对：RIFF/WAVE/fmt 16/PCM=1/mono/16k/blockAlign=2/data 长度，全部正确。16k PCM mono 是所有在用 ASR 的标准输入。`VOICE_RECOGNITION` 源的机型差异无法在代码层排除，但既然两路 ASR 都能转出 8 字文本，音频质量至少达到"可转写"。

### 方向 C：DashScope 调用格式 —— ❌ 排除

`transcribeAudioWithFallbackModel()`（`openai-client.ts:386`）同时被环境音转写复用（`review-engine.ts:748` 和 `:1873`）。备忘录自己说"环境音频有时可以形成 transcript"——同一个函数、同一种 `input_audio` + data URL 格式在环境音上能出文本，格式就不是根因。可选改进：按 DashScope 规范补 `format: "wav"` 字段，无害。

## 最小修复方案（按优先级）

### 1. resolver 改为"显式提问默认放行"（一处改动，预期直接治愈）

`resolveAssistantQueryText` 增加 `explicitQuery: boolean` 参数（`/assistant/query` 端点和 `transcribeAssistantQuery` 内的 `shouldAcceptQueryTranscript` 都传 `true`）：

```ts
export function resolveAssistantQueryText(params: {
  queryText: string;
  modeHint?: AssistantModeHint;
  explicitQuery?: boolean;   // 用户按了按钮
}): AssistantQueryResolution {
  const rawQueryText = normalizeQuestion(params.queryText);
  if (!rawQueryText) return { queryText: "", rawQueryText, replaced: false };

  const normalizedQueryText = normalizeAssistantQueryAliases(rawQueryText);
  if (normalizedQueryText !== rawQueryText) { /* 原逻辑不变 */ }

  const extracted = extractSupportedShortQuestion(rawQueryText);
  if (extracted) { /* 原逻辑不变 */ }

  // 新增：显式提问模式下，短文本直接放行，让 LLM 判断意图
  if (params.explicitQuery && rawQueryText.length <= 40 &&
      !looksLikeAmbientQueryTranscript(rawQueryText)) {
    return { queryText: rawQueryText, rawQueryText, replaced: false };
  }

  // 白名单只继续负责：长环境转写抽取 + 非显式路径
  ...原有拒绝逻辑...
}
```

放行后 `index.ts:1424-1426` 的判断自然走 `tryAnswerAssistantQueryWithModel`，由模型结合 recent context 回答——这正是备忘录方向 E 建议的"交给 LLM 判断"。白名单保留两个职责：从 >40 字的环境转写里抽问题句、识别 alias（读全文/简短点等指令）。

### 2. 打通诊断闭环：保留 query WAV + host 侧 raw 预览日志

- `index.ts:294-296` 的 `finally { fs.rm(...) }` 改为受配置开关（如 `debugKeepAssistantQueryAudio`）控制，保留最近 N 个 query WAV 到 state 目录。
- host 侧 `api.logger.info` 打 rawQueryText 前 32 字预览（Android debug log 已加，但要真机才看得到；host 日志更容易拿）。

### 3. 修 `index.ts:291-292` 记账 bug

local ASR 有 transcript 被拒时不要再补 push `query_time_local_asr_empty`：

```ts
if (!localAsr.transcript?.trim() && localAsr.analysisFailureReason !== "query_time_local_asr_disabled") {
  failureReasons.push(localAsr.analysisFailureReason ?? "query_time_local_asr_empty");
}
```

### 4. SenseVoice 强制中文

配置 `localAsrLanguage: "zh"`（或把默认值从 `auto` 改 `zh`）。

### 5. 中期：Android 专用 query recorder（建议做，但不阻塞 1–4）

按下按钮 → 进入专用录音状态机：固定最长 6s 窗口，检测到 ≥300ms 人声后若出现 800ms 尾静音则提前结束 → 直接上传，期间暂停环境采集。`SensorForegroundService` 里 expired/pre-armed/too-long/continued-ambient 四个拒绝分支全部删除（专用录音不存在这些歧义）。收益：不丢首音节、延迟从 ~2.4s+ 降到 <1s、背景音不再卷入。

### 6. Android SpeechRecognizer：不建议作为主路径

老手机若无 GMS，系统 `SpeechRecognizer` 很可能不可用（飞书用的是自家云端 ASR，不能证明系统识别器可用）。保留 host-side ASR 架构，修 resolver 即可。可作为后续可选的端侧加速路径。

## 最短可复现实验（区分三类问题）

**第 0 步（最快，已具备条件）**：debug APK 已带 `rawQueryPreview` 日志。真机再测一次，看 logcat：

| rawQueryPreview 内容 | 结论 | 动作 |
|---|---|---|
| 文本 ≈ 用户原话 | 纯 resolver 问题 | 修复 1 即愈 |
| 文本是乱码/严重误听 | ASR 问题 | 修复 4，必要时换 provider；检查 WAV |
| 为空（`-`） | 录音/上传问题 | 走第 1-2 步 |

**第 1 步**：开 `debugKeepAssistantQueryAudio`（修复 2），拿到 query WAV，人耳听一遍 —— 清晰与否直接二分"录音问题 vs 后端问题"。

**第 2 步**：把同一个 WAV 手动喂三路 ASR（写个 10 行脚本调 `transcribeAudioWithLocalAsr` / `transcribeAudioWithFallbackModel`），对比输出 —— 区分"单一 provider 问题 vs 普遍 ASR 问题"。

**第 3 步**：用电脑录一段已知清晰的"刚才发生了什么.wav"，直接 `curl /api/clawsense/assistant/query` —— 完全绕开 Android，单测 host 链路。

## 已实施修复（2026-06-11 深夜）

上述最小修复方案 1–4 已全部落地并部署到本地 gateway：

1. `resolveAssistantQueryText` 新增 `explicitQuery` 模式（`src/realtime-assistant.ts`），显式提问下 2–40 字、≤2 个句读、非描述风格开头（"听起来/好像/这段音频…"）的转写直接放行给 LLM；`index.ts` 两处调用点（逐路 ASR 接受判定 + 端点最终判定）均传 `explicitQuery: true`。
2. 修复 `index.ts` 记账 bug：local/fallback ASR 有转写被拒时不再误报 `*_empty`。
3. query WAV 留存：新配置 `assistantQueryAudioKeepCount`（默认 10），保留最近 N 个 query 音频在 `state/plugins/clawsense/assistant-queries/`；host 日志新增 `rawPreview` 行。
4. `localAsrLanguage` 默认值与本地 gateway 配置均改为 `zh`；DashScope `input_audio` 补 `format` 字段。

验证记录：

- `npm run build` 通过；`npm test` 209/209 通过（新增 4 个 explicit 模式单测）。
- 端到端冒烟（macOS TTS 合成 16k WAV → 真实 `/api/clawsense/assistant/query`）：
  - "刚才发生了什么" → `queryText` 正确、`answerSource=model`，回答引用了真实 recent context。
  - "我桌上的钥匙去哪了"（白名单外自由问法，旧版必拒）→ 正确接受并由模型回答。
- gateway 日志确认输出 `rawPreview` 诊断行；query WAV 确认留存在磁盘。

Android 端无改动，无需重装 APK。待办（验证通过后再决定）：Android 专用 query recorder 重构（方案 5）。

## 第二轮：Android 专用 query recorder（同日凌晨，真人验证仍超时后实施）

Host 修复部署后真人验证仍失败，提示文案为 Android 本地超时消息"这次没有听到可用问题"——说明 query clip 根本没被切出来，请求未到 host。于是实施方案 5：

1. **专用 query recorder**（`AndroidAudioSensorHal.kt`）：点击"问实时助手"后立即开始录音（含 pre-roll，避免丢首字），最长 8 秒，一旦录到 ≥400ms 人声且尾静音 ≥1.2 秒就提前结束；query 期间环境管线完全暂停；灵敏度阈值 0.008（低于环境 VAD 的 0.012）。不再依赖环境 VAD flush。
2. **Service 重写**（`SensorForegroundService.kt`）：`triggerAssistantQuery` 直接调用专用录音；删除 `handleCapturedAudioClip` 里全部 query 拦截/拒绝分支（expired / pre-armed / too-long / continued-ambient）；保留 12 秒 watchdog 仅作 UI 兜底。
3. **音源换回 `MIC`**：dumpsys audio 历史显示，使用 `MIC` 的会话（00:33–01:09）clip 能到达 host，而 `VOICE_RECOGNITION` 会话（01:10–02:50）期间真人说话连 VAD 都不触发——该机型 `VOICE_RECOGNITION` 初始化成功但信号近零，正是上一轮"改成 VOICE_RECOGNITION"修复造成的回退。
4. 额外发现：手机 adb reverse 隧道早已断开（设备心跳停在 5 月 31 日），期间即使录到音也传不上去；已重建隧道。

真机验证（2026-06-11 02:57）：用户真人说"刚才发生了什么"→ 新录音器切出 ~5s clip → host SenseVoice 一字不差转写 → `accepted=true` → 模型回答 → 手机 TTS 正常播报。全链路打通。

## 根因排序汇总

1. **E：resolver 白名单过严**（确定，有日志直接证据）
2. **A：复用环境 VAD**（确认的设计缺陷，放大 E；负责丢首字、延迟、Android 侧拒杀）
3. **D：SenseVoice auto 语言**（加剧短句误听）
4. B/C：排除（WAV header 正确；DashScope 调用与环境音共用且环境音可转写）
