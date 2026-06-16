# ClawSense 实时助手显式提问 ASR 故障交接备忘录

日期：2026-06-11  
项目路径：`/Users/cedric/Documents/ClawSense`

## 一句话结论

ClawSense Android 客户端的“实时助手语音提问”目前仍不可用：用户点击“问实时助手”后靠近手机说话，系统仍无法稳定识别为有效提问；但同一台手机使用飞书语音转文字可以清晰转写，因此麦克风硬件大概率不是根因。问题更可能出在 ClawSense 的显式提问录音链路、VAD 分段、音频源选择、上传格式、服务端 ASR 调用、或 query 文本判定策略上。

## 用户期望

用户希望把旧 Android 手机作为现实世界实时助手终端：

- 用户点击或未来通过唤醒词触发提问。
- 用户用自然语言问：
  - “刚才发生了什么？”
  - “刚才他们说了什么？”
  - “刚才讨论的重点是什么？”
  - “过去 4 个小时我们聊了什么？”
- 手机把用户提问录下来，发送到 OpenClaw / ClawSense host。
- Host 做 ASR，拿到 `queryText`。
- Host 根据 recent context / media memory 生成答案。
- 手机本地 TTS 朗读 `answerSpokenText`。

当前卡在：用户提问无法被稳定转成有效 `queryText`。

## 当前实际现象

1. Android 端环境感知链路可以上传音频 / 图片。
2. 环境音频有时可以形成 transcript，说明普通录音上传和服务端部分 ASR 链路并非完全不可用。
3. 点击“问实时助手”后，Android logcat 可以看到 assistant query 被 armed，也可能捕获到 query clip。
4. 但服务端返回经常表现为：
   - `queryTextLen=0`
   - `sttRewrite=ambient_transcript_no_question`
   - `sttFailure` 包含 `runtime_stt_empty`、`query_time_local_asr_unusable_query`、`query_time_asr_unusable_query`
5. 用户真人靠近手机说话仍然不通。
6. 同一手机在飞书里做语音转文字非常清晰。

## 最近一次关键日志形态

以下是此前自动/模拟验证中观察到的典型日志形态，真实用户反馈仍是“不通”：

```text
Assistant query armed mode=AUTO timeoutMs=15000 graceMs=2500
Assistant query boundary prepared; ambient conversation state reset
Audio clip ready. ... durationMs=4353 voicedMs=1664 ...
Assistant query clip captured mode=AUTO durationMs=4353 bytes=139308
Assistant query submitting mode=AUTO durationMs=4353 bytes=139308
Assistant query answered mode=AUTO source=template action=none queryTextLen=0 answerLen=115 spokenLen=37
sttProvider=runtime-stt|local-asr:sherpa-onnx-sensevoice:auto|dashscope-stt:qwen3-asr-flash
sttFailure=runtime_stt_empty|query_time_local_asr_unusable_query|query_time_local_asr_empty|query_time_asr_unusable_query
sttRewrite=ambient_transcript_no_question rawQueryLen=8
```

`rawQueryLen=8` 曾高度可疑，因为“刚才发生了什么？”正好是 8 个中文字符左右。这提示 ASR 可能已经听到了类似文本，但 query resolver 把它误杀为“非问题”。我们已经修了这一类规则，但用户再次真人验证仍失败。

## 当前架构简述

### Android 侧

主要文件：

- `android/app/src/main/java/ai/openclaw/clawsense/sensors/AndroidAudioSensorHal.kt`
- `android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt`
- `android/app/src/main/java/ai/openclaw/clawsense/data/OkHttpClawSenseApi.kt`
- `android/app/src/main/java/ai/openclaw/clawsense/data/DeviceModels.kt`

目前 Android 音频链路是：

1. `AndroidAudioSensorHal` 常驻 `AudioRecord`。
2. 使用简单 RMS VAD 判断 voiced / silence。
3. 生成 WAV clip。
4. 普通环境音频走 `uploadAudio`。
5. 用户点击“问实时助手”后，`SensorForegroundService.triggerAssistantQuery()` 设置 `pendingAssistantQuery=true`。
6. 下一段由 VAD flush 出来的 audio clip 会被 `handleCapturedAudioClip()` 截获为 assistant query。
7. Android 调用 `/api/clawsense/assistant/query`。
8. 收到响应后用本地 TTS 播报。

重要设计问题：

- 显式提问目前仍复用环境 VAD clip 机制。
- 这可能不适合语音命令，因为它依赖“声音触发 + 尾部静音 flush”。
- 如果环境声音、手机扬声器、背景视频或人声持续存在，query clip 边界可能不稳定。
- 如果用户问题很短，VAD 或 ASR 可能得到非常短 / 不完整 / 低质量音频。

### Host / 插件侧

主要文件：

- `index.ts`
- `src/realtime-assistant.ts`
- `src/local-asr.ts`
- `src/openai-client.ts`

Host 的 query ASR 流程大致是：

1. `/api/clawsense/assistant/query` 收到 `queryAudio` base64 WAV。
2. `transcribeAssistantQuery()` 尝试：
   - OpenClaw runtime STT
   - local ASR：`sherpa-onnx-sensevoice`
   - fallback ASR：例如 DashScope `qwen3-asr-flash`
   - primary multimodal audio understanding
3. 每一路 ASR 得到 transcript 后，会用 `resolveAssistantQueryText()` 判断它是不是支持的问题。
4. 如果被认为像环境音 / 访谈内容 / 非问题，就会被 reject。
5. 最终 queryText 为空时，assistant 走“没听清 / 环境音”模板回答。

## 最近已尝试的修复

### 1. Android 音频源调整

文件：`AndroidAudioSensorHal.kt`

改动：

- 默认音频源从 `MediaRecorder.AudioSource.MIC` 改为 `MediaRecorder.AudioSource.VOICE_RECOGNITION`。
- 如果初始化失败，再 fallback 到 `MIC`。
- 日志打印实际使用音源。

目的：

- 尽量接近飞书语音转文字这类语音识别输入源。

结果：

- 代码构建通过。
- 用户真人测试仍反馈“不通”。

### 2. query resolver 支持更多短问句

文件：`src/realtime-assistant.ts`

修复前：

- 支持 “刚才讨论的重点是什么？”
- 不一定支持 “刚才发生了什么？”

修复后：

- 增加支持：
  - `刚才/刚刚发生了什么`
  - `刚才/刚刚看到了什么`
  - `刚才/刚刚听到了什么`

结果：

- 单元测试通过。
- 用户真人测试仍反馈“不通”。

### 3. ASR fallback 不再提前短路

文件：`index.ts`

改动：

- 如果 runtime/local/provider 某一路 ASR 产出文本但被判为不可用 query，不立刻返回。
- 继续尝试后续更强 fallback。
- 所有路径都不可用时，把 rejected transcript 留给诊断。

结果：

- 构建通过。
- 用户真人测试仍反馈“不通”。

### 4. 增加 debug 诊断

文件：

- `index.ts`
- `SensorForegroundService.kt`

改动：

- `stt.rawQueryText` 只要有 ASR 文本就返回。
- Android debug log 增加 `queryPreview/rawQueryPreview` 短预览。

目的：

- 下次不要只看 `rawQueryLen` 猜测，要直接看到它听成了什么。

结果：

- 已部署，但尚未得到下一轮有效日志反馈。

## 已通过的验证

```bash
npm run build
npm test -- test/realtime-assistant.test.ts
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
bash scripts/local-openclaw.sh setup
bash scripts/local-openclaw.sh gateway-restart
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:18789 tcp:18789
bash scripts/local-openclaw.sh devices
```

这些只能说明代码能构建、服务能跑、设备在线；不能证明真人语音提问可用。

## 当前最可疑的问题方向

请外部 AI 重点判断下面几个方向：

### 方向 A：复用环境 VAD 作为 query recorder 是根本设计错误

当前显式提问不是“按下按钮后录固定窗口音频”，而是：

- 按下按钮后 pending query。
- 等同一个环境 VAD 产生下一段 clip。
- 把这段 clip 当 query。

这可能导致：

- 用户问题太短，clip 不完整。
- VAD 等尾静音，延迟大。
- 背景视频 / 环境人声被合并进 query。
- 环境音持续时，提问被拒绝为 continued ambient。
- clip 过长时被认为不是 query。

可能更好的做法：

- 点击“问实时助手”后进入专用 query recorder。
- 直接录固定 4-6 秒，或按住说话。
- 不依赖环境 VAD session。
- 结束后直接上传该 query WAV。
- 环境采集在 query 期间暂停。

### 方向 B：Android `AudioRecord` 参数或 WAV 质量不适合 ASR

需要确认：

- WAV header 是否正确。
- 16k PCM mono 是否被所有 ASR provider 正确识别。
- `VOICE_RECOGNITION` 是否在该机型上反而音量很低 / 处理异常。
- RMS threshold 是否导致语音 clip 太短。
- `readFrameSize=2048`、`voiceActivationFrames=2`、`silenceTimeoutMs=2400` 是否合理。
- 是否应该使用 Android 官方 `SpeechRecognizer` 做端侧 query ASR，而不是把 query 音频交给 host。

### 方向 C：服务端 ASR provider 调用格式可能不对

当前 fallback ASR 对 OpenAI-compatible chat ASR 使用：

```ts
messages: [
  {
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: {
          data: buildAudioDataUrl(params.body, params.fileName, params.mime),
        },
      },
    ],
  },
],
asr_options: {
  enable_itn: false,
},
```

需要确认：

- DashScope / Qwen ASR 的 OpenAI-compatible API 是否真的接受这种 `input_audio` 格式。
- 是否应该使用专门的 ASR endpoint，而不是 chat completions。
- `buildAudioDataUrl()` 是否多包了一层 data URL，provider 可能需要纯 base64。
- `qwen3-asr-flash` 是否适合极短中文 query。

### 方向 D：local ASR / SenseVoice 模型不适合短命令

当前 local ASR 是 `sherpa-onnx-sensevoice`。

需要确认：

- 模型语言配置是否正确。
- 是否需要强制 `zh`，而不是 `auto`。
- 是否需要 VAD 前后多加静音 / 增益。
- 是否对短句容易输出乱码或省略。

### 方向 E：query resolver 仍过度严格

即使 ASR 文本正确，也可能被 `resolveAssistantQueryText()` 拦掉。

需要确认：

- 是否应该在 assistant query 模式下更宽松：只要不是长环境 transcript，就先交给 LLM 判断。
- 是否不该用硬编码 regex 判断“是否支持的问题”。
- 是否应把 raw query + recent context 一起交给模型，让模型判断用户意图。

## 建议外部 AI 给出的产物

请让外部 AI 输出：

1. 最可能根因排序。
2. 建议的最小修复方案。
3. 是否建议重构 Android query recorder。
4. 是否建议 Android 端直接使用系统 `SpeechRecognizer` 或第三方端侧 ASR。
5. 如果保留 host-side ASR，推荐的 provider/API 调用方式。
6. 针对当前代码的具体修改点和伪代码。
7. 一套最短可复现实验：
   - 如何确认 query WAV 是否清晰。
   - 如何把 query WAV 单独拿出来喂给 ASR。
   - 如何区分录音问题 / ASR API 问题 / resolver 问题。

## 可直接复制给外部 AI 的 Prompt

```text
你是一个资深 Android 音频、ASR、实时语音助手架构工程师。请帮我诊断 ClawSense 项目的实时助手语音提问失败问题。

项目目标：
ClawSense 用旧 Android 手机采集现实世界音频/图片，并连接云端 OpenClaw。用户点击“问实时助手”后，说一句问题，例如“刚才发生了什么”“刚才他们说了什么”“过去4个小时我们聊了什么”，手机应录下问题，上传给 host，host ASR 得到 queryText，然后结合 recent context 回答，手机本地 TTS 朗读。

当前问题：
真人测试时，点击“问实时助手”后靠近手机说话，系统仍无法稳定识别用户说的话。用户用同一台手机在飞书里语音转文字非常清晰，所以麦克风硬件大概率没坏。ClawSense 环境音频有时能转写，说明普通录音上传和部分 ASR 不是完全不可用。但显式提问链路经常返回 queryTextLen=0，sttRewrite=ambient_transcript_no_question。

当前 Android 设计：
- AndroidAudioSensorHal 常驻 AudioRecord。
- 用 RMS VAD 切环境音频 clip。
- 点击“问实时助手”后，SensorForegroundService 设置 pendingAssistantQuery=true。
- 下一段由环境 VAD flush 出来的 clip 被当成 assistant query。
- 也就是说显式提问复用了环境 VAD clip 机制，而不是专用 query recorder。
- query 期间会 reset ambient conversation state，并尝试截获下一段音频。

当前 Host 设计：
- /api/clawsense/assistant/query 收到 queryAudio base64 WAV。
- transcribeAssistantQuery 依次尝试 runtime STT、local ASR sherpa-onnx-sensevoice、fallback ASR（如 DashScope qwen3-asr-flash）、primary multimodal audio。
- 每路 ASR 产出 transcript 后，会用 resolveAssistantQueryText 判断是不是支持的问题。
- 如果像环境音或不是问题，会被拒绝，最后 queryText 可能为空。

最近修过但仍失败：
- Android AudioRecord 默认源从 MIC 改成 VOICE_RECOGNITION，失败 fallback MIC。
- query resolver 增加支持“刚才发生了什么/刚刚看到了什么/刚才听到了什么”。
- ASR fallback 不再因某一路 unusable query 提前短路。
- stt.rawQueryText 和 Android debug log 增加 rawQueryPreview 诊断。
- 构建和单元测试都通过，但真人语音仍反馈不通。

请你重点分析：
1. 复用环境 VAD 作为显式 query recorder 是否是根本设计错误？
2. Android 端是否应该改成点击后专用录固定 4-6 秒 query WAV，而不是等 VAD clip？
3. 是否应该用 Android SpeechRecognizer 或端侧 ASR 先把用户提问转文字，再发 queryText 给 host？
4. 如果继续 host-side ASR，Android WAV、AudioRecord、采样率、音频源、增益、静音处理应该怎么改？
5. DashScope/Qwen ASR 的 OpenAI-compatible 调用格式是否可能错了？是否应该用专用 ASR endpoint？
6. query resolver 是否过度严格，是否应该让 LLM 判断 raw transcript 是否为用户问题？
7. 请给出你认为最小可行的修复方案、具体代码修改建议、以及一套最短诊断实验，能区分录音问题、ASR API 问题和 resolver 问题。

相关文件：
- android/app/src/main/java/ai/openclaw/clawsense/sensors/AndroidAudioSensorHal.kt
- android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt
- android/app/src/main/java/ai/openclaw/clawsense/data/OkHttpClawSenseApi.kt
- android/app/src/main/java/ai/openclaw/clawsense/data/DeviceModels.kt
- index.ts
- src/realtime-assistant.ts
- src/local-asr.ts
- src/openai-client.ts
```

