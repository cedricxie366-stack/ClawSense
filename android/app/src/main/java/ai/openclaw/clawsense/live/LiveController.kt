package ai.openclaw.clawsense.live

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import ai.openclaw.clawsense.AppGraph
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

data class LiveSnapshot(
  val connected: Boolean = false, val connecting: Boolean = false, val configuring: Boolean = false, val speaking: Boolean = false,
  val inputReady: Boolean = false,
  val backgroundPreparing: Boolean = false, val startupStage: String = "",
  val transcript: String = "", val answer: String = "", val route: String = "", val error: String? = null,
  val personaJson: String = "", val presetsJson: String = "", val voices: List<String> = emptyList(),
  val turnId: String = "", val turnCompleted: Boolean = false,
  val styleControl: Boolean = false, val echoAvailable: Boolean = false, val notice: String? = null, val workResults: String = "",
  val visualEnabled: Boolean = false, val visualDescription: String = "",
  val historyText: String = "", val workJson: String = "[]",
  val hostTimingsJson: String = "",
  val diagnosticCode: String? = null,
  val inputDiagnosticsJson: String = "",
  val inputReceipt: LiveInputReceipt = LiveInputReceipt(),
)
data class PlaybackStopTiming(val requestedMs: Long, val pauseCompletedMs: Long?, val completedMs: Long, val gateWaitMs: Long, val pauseMs: Long, val flushMs: Long)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LiveController(private val context: Context) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val sockets = LiveSocketFactory()
  val socketDefaultNoDelay: Boolean? get() = sockets.defaultNoDelay
  val socketNoDelayEnabled: Boolean? get() = sockets.configuredNoDelay
  private val client = OkHttpClient.Builder().socketFactory(sockets).connectTimeout(10, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build()
  private val mutable = MutableStateFlow(LiveSnapshot())
  val state = mutable.asStateFlow()
  private val gate = LiveEventGate()
  @Volatile private var socket: WebSocket? = null
  @Volatile private var track: AudioTrack? = null
  @Volatile private var playbackDone = false
  @Volatile private var playingPacket = false
  private val playbackProgress = LivePlaybackProgress()
  private var playbackFinishJob: Job? = null
  private var validationPlaybackMuted = false
  @Volatile private var validationAudioObserver: ((ByteArray, Int) -> Unit)? = null
  @Volatile var lastPlaybackCompletedElapsedMs = 0L; private set
  @Volatile var suppressAmbientUntil: Long = 0; private set
  private val generation = AtomicLong()
  private val playbackGate = LivePlaybackGate(generation)
  private val connectionGeneration = AtomicLong()
  private var connectJob: Job? = null
  private var connectionDeadline: Job? = null
  @Volatile var captureFrame: (suspend () -> ai.openclaw.clawsense.data.CapturedImageFrame)? = null
  fun setVisualEnabled(enabled: Boolean) { mutable.update { it.copy(visualEnabled = enabled, visualDescription = "") } }
  private val configurationGeneration = AtomicLong()
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
  // Live is hands-free assistant playback, not a phone call. Follow the user's
  // media output (speaker/headphones) without changing system volume or mode.
  private val playbackAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
    .build()
  private val focus = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    .setAudioAttributes(playbackAttributes)
    .setOnAudioFocusChangeListener { change -> if (change < 0 && (mutable.value.connected || mutable.value.connecting)) { interrupt(); ai.openclaw.clawsense.service.SensorServiceController.stopLive(context); mutable.update { it.copy(notice = "通话或其他音频占用，Live 已停止。请返回后自行开启。") } } }.build()
  private data class Audio(val generation: Long, val data: ByteArray, val rate: Int, val seq: Long)
  private val audio = Channel<Audio>(32)
  private var playerGeneration = -1L
  val observedTurns = AtomicLong()
  val inputFrames = AtomicLong()
  @Volatile var lastPreparationMs = 0L; private set
  @Volatile var lastPreparationDetails = ""; private set
  @Volatile var lastConnectionMs = 0L; private set
  private var connectionStartedMs = 0L
  @Volatile var inputRmsMax = 0.0; private set
  fun resetInputLevel() { inputRmsMax = 0.0 }
  val audioWrites = AtomicLong()
  @Volatile var firstAudioElapsedMs = 0L; private set
  @Volatile var firstAudioReceivedElapsedMs = 0L; private set
  @Volatile var lastStopElapsedMs = 0L; private set
  @Volatile var lastStopRequestedElapsedMs = 0L; private set
  @Volatile var lastStopGateWaitMs = 0L; private set
  @Volatile var lastPauseCallMs = 0L; private set
  @Volatile var lastFlushCallMs = 0L; private set
  private val pauseTimes = java.util.concurrent.CopyOnWriteArrayList<Long>()
  private val stopTimings = java.util.concurrent.CopyOnWriteArrayList<PlaybackStopTiming>()
  fun firstPauseAfter(at: Long): Long? = pauseTimes.firstOrNull { it >= at }
  fun playbackStopsAfter(at: Long): List<PlaybackStopTiming> = stopTimings.filter { it.requestedMs >= at }
  fun playbackState(): Int = track?.playState ?: AudioTrack.PLAYSTATE_STOPPED
  internal fun playbackProgressSnapshot(): LivePlaybackProgress.Snapshot =
    playbackGate.current(generation.get()) { playbackProgress.snapshot(track?.playbackHeadPosition ?: 0) }
      ?: LivePlaybackProgress.Snapshot(0, 0)
  internal fun muteValidationPlayback(muted: Boolean) {
    check(ai.openclaw.clawsense.BuildConfig.DEBUG)
    playbackGate.current(generation.get()) {
      validationPlaybackMuted = muted
      track?.let { check(it.setVolume(if (muted) 0f else 1f) == AudioTrack.SUCCESS) }
    }
  }
  internal fun observeValidationAudio(observer: ((ByteArray, Int) -> Unit)?) {
    check(ai.openclaw.clawsense.BuildConfig.DEBUG)
    validationAudioObserver = observer
  }
  init { scope.launch { for (frame in audio) {
    if (frame.generation != generation.get()) continue
    playingPacket = true
    try {
      val output = playbackGate.current(frame.generation) {
        if (playerGeneration != frame.generation) { track?.release(); track = null; playerGeneration = frame.generation; playbackProgress.reset() }
        val current = track ?: AudioTrack.Builder().setAudioAttributes(playbackAttributes)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(frame.rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
          .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(4096, AudioTrack.getMinBufferSize(frame.rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT))).build().also { track = it; check(it.setVolume(if (validationPlaybackMuted) 0f else 1f) == AudioTrack.SUCCESS); it.play() }
        if (!mutable.value.speaking) { mutable.update { it.copy(speaking = true) }; send("playback", "active" to JsonPrimitive(true)) }
        suppressAmbientUntil = Long.MAX_VALUE
        current
      } ?: continue
      var offset = 0
      while (offset < frame.data.size && frame.generation == generation.get()) {
        val written = playbackGate.current(frame.generation) {
          if (firstAudioElapsedMs == 0L) firstAudioElapsedMs = android.os.SystemClock.elapsedRealtime()
          output.write(frame.data, offset, minOf(1280, frame.data.size - offset), AudioTrack.WRITE_NON_BLOCKING).also { if (it > 0) { audioWrites.incrementAndGet(); playbackProgress.writtenBytes(it.toLong()) } }
        } ?: break
        if (frame.generation != generation.get()) break
        if (written < 0) error("音频播放失败")
        if (written == 0) { delay(4); continue }
        offset += written
      }
      if (frame.generation == generation.get()) send("audio_ack", "seq" to JsonPrimitive(frame.seq))
      if (playbackDone && audio.isEmpty) scheduleFinish()
    } catch (_: Exception) { if (frame.generation == generation.get()) fail("声音播放失败，回答文字仍保留。") } finally { playingPacket = false; if (playbackDone && audio.isEmpty) scheduleFinish() }
  } } }
  private fun scheduleFinish() {
    val epoch = generation.get()
    playbackGate.current(epoch) {
      playbackFinishJob?.cancel()
      playbackFinishJob = scope.launch {
        val began = android.os.SystemClock.elapsedRealtime()
        while (isActive) {
          delay(20)
          val waiting = playbackGate.current(epoch) {
            if (!playbackDone || playingPacket || !audio.isEmpty) return@current false
            if (playbackProgress.snapshot(track?.playbackHeadPosition ?: 0).drained) {
              finishPlayback(); false
            } else if (android.os.SystemClock.elapsedRealtime() - began >= 3000) {
              fail("声音播放未完成，回答文字仍保留。", "playback_drain_timeout"); false
            } else true
          } ?: false
          if (!waiting) return@launch
        }
      }
    }
  }
  private fun finishPlayback() {
    if (!mutable.value.speaking) return
    lastPlaybackCompletedElapsedMs = android.os.SystemClock.elapsedRealtime()
    suppressAmbientUntil = System.currentTimeMillis() + 1200
    mutable.update { it.copy(speaking = false) }
    send("playback", "active" to JsonPrimitive(false))
  }
  fun setEchoAvailable(available: Boolean) { mutable.update { it.copy(echoAvailable = available) } }
  fun prepare(vision: Boolean = false) {
    if (mutable.value.connected || mutable.value.connecting || mutable.value.configuring) return
    val version = configurationGeneration.incrementAndGet()
    lastPreparationMs = 0L
    scope.launch {
      runCatching {
        val session = AppGraph.repository(context).requireSession()
        val request = Request.Builder().url(session.uploadBaseUrl.trimEnd('/') + "/live").header("Authorization", "Bearer ${session.deviceSecret}").build()
        var canPrepare = false
        client.newCall(request).execute().use { response ->
          check(response.isSuccessful)
          val data = json.parseToJsonElement(response.body!!.string()).jsonObject
          canPrepare = data["preparationSupported"]?.jsonPrimitive?.booleanOrNull == true
          if (version == configurationGeneration.get()) mutable.update { it.copy(personaJson = data["persona"].toString(), presetsJson = data["presets"].toString(), error = null) }
        }
        if (canPrepare && version == configurationGeneration.get()) {
          mutable.update { it.copy(backgroundPreparing = true) }
          val began = android.os.SystemClock.elapsedRealtime()
          // Preparing generic local voice assets does not connect Live or start sensors.
          runCatching {
            val warm = Request.Builder().url(session.uploadBaseUrl.trimEnd('/') + "/live-prepare")
              .header("Authorization", "Bearer ${session.deviceSecret}")
              .post(buildJsonObject { put("vision", vision) }.toString().toRequestBody("application/json".toMediaType())).build()
            client.newCall(warm).apply { timeout().timeout(30, TimeUnit.SECONDS) }.execute().use { response ->
              if (response.isSuccessful && version == configurationGeneration.get()) {
                lastPreparationMs = android.os.SystemClock.elapsedRealtime() - began
                lastPreparationDetails = response.body?.string().orEmpty()
              }
            }
          }
          if (version == configurationGeneration.get()) mutable.update { it.copy(backgroundPreparing = false) }
        }
      }.onFailure { if (version == configurationGeneration.get()) mutable.update { it.copy(error = "Live 设置暂时无法加载，请检查设备连接。") } }
    }
  }
  fun connect(provider: String = "local", invited: Boolean = false) {
    if (mutable.value.connecting || mutable.value.connected || mutable.value.configuring) return
    if (audioManager.requestAudioFocus(focus) != android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { mutable.update { it.copy(error = "音频正在被其他应用使用，请稍后开启 Live。") }; return }
    configurationGeneration.incrementAndGet()
    val epoch = connectionGeneration.incrementAndGet()
    connectionStartedMs = android.os.SystemClock.elapsedRealtime()
    mutable.update { it.copy(connecting = true, backgroundPreparing = false, startupStage = "connecting", inputReady = false, error = null, diagnosticCode = null, inputDiagnosticsJson = "", inputReceipt = LiveInputReceipt()) }
    connectionDeadline?.cancel()
    connectionDeadline = scope.launch {
      delay(30_000)
      if (epoch == connectionGeneration.get() && mutable.value.connecting) fail("Live 连接超时，请检查电脑上的服务和连接后重试。")
    }
    connectJob = scope.launch {
      try {
        val session = AppGraph.repository(context).requireSession()
        val request = Request.Builder().url(session.uploadBaseUrl.trimEnd('/') + "/live").header("Authorization", "Bearer ${session.deviceSecret}").get().build()
        val call = client.newCall(request).apply { timeout().timeout(10, TimeUnit.SECONDS) }
        val info = call.execute().use { response ->
          check(response.isSuccessful) { if (response.code == 404) "电脑尚未开启 Live 服务，请启动后重试。" else if (response.code in listOf(401, 403)) "Live 配对或授权已失效，请检查连接设置。" else "电脑端 Live 服务暂时不可用，请检查后重试。" }
          json.parseToJsonElement(response.body!!.string()).jsonObject
        }
        if (epoch != connectionGeneration.get()) return@launch
        mutable.update { it.copy(personaJson = info["persona"].toString(), presetsJson = info["presets"].toString()) }
        val url = info["websocketUrl"]!!.jsonPrimitive.content
        // The host may advertise a separate port, but must retain the paired host identity.
        val paired = java.net.URI(session.uploadBaseUrl); val live = java.net.URI(url)
        check(live.host == paired.host && live.scheme in listOf("ws", "wss") && live.userInfo == null && (paired.scheme != "https" || live.scheme == "wss")) { "Live 地址与已配对主机不一致" }
        socket = client.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer ${session.deviceSecret}").build(), object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) { if (epoch == connectionGeneration.get()) webSocket.send(buildJsonObject { put("type", "hello"); put("provider", provider); put("vision", mutable.value.visualEnabled); put("invited", invited) }.toString()) else webSocket.close(1000, null) }
          override fun onMessage(webSocket: WebSocket, text: String) { if (epoch == connectionGeneration.get()) runCatching { receive(json.parseToJsonElement(text).jsonObject) }.onFailure { fail("Live 数据无法解析，请重新连接。") } }
          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (epoch == connectionGeneration.get()) fail("Live 连接中断，请重新连接。", "socket_" + t.javaClass.simpleName) }
          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (epoch == connectionGeneration.get()) fail(if (code == 1000) "Live 已结束" else "Live 服务断开，请检查模型配置后重连。", "ws_closed_$code") }
        })
      } catch (e: Exception) { if (epoch == connectionGeneration.get()) fail(if (e is java.io.IOException) "无法连接电脑上的 Live 服务，请确认服务已启动，并保持手机与电脑连接。" else e.message ?: "Live 连接失败，请检查电脑服务后重试。") }
    }
  }
  private fun receive(event: JsonObject) {
    val playbackEpoch = generation.get()
    val type = event["type"]!!.jsonPrimitive.content
    if (type == "initializing") {
      if (mutable.value.connecting) mutable.update { it.copy(startupStage = event["stage"]?.jsonPrimitive?.content.orEmpty()) }
      return
    }
    if (type == "ready") {
      lastConnectionMs = android.os.SystemClock.elapsedRealtime() - connectionStartedMs
      connectionDeadline?.cancel(); connectionDeadline = null
      gate.ready(event["sessionId"]!!.jsonPrimitive.content)
      val caps = event["capabilities"]?.jsonObject?.get(if (event["selected"]?.jsonPrimitive?.content == "minicpm-o") "native" else "local")?.jsonObject
      mutable.update { it.copy(connected = true, connecting = false, route = event["selected"]?.jsonPrimitive?.content.orEmpty(), voices = caps?.get("voices")?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty(), styleControl = caps?.get("styleControl")?.jsonPrimitive?.booleanOrNull == true, notice = event["notice"]?.jsonPrimitive?.content?.let(::liveNoticeMessage)) }
      refreshResults()
      return
    }
    if (mutable.value.configuring && type in listOf("turn_started", "transcript", "text_delta", "audio", "completed")) return
    if (event["seq"] != null && !gate.accept(event["sessionId"]!!.jsonPrimitive.content, event["turnId"]!!.jsonPrimitive.content, event["seq"]!!.jsonPrimitive.long, type)) return
    when (type) {
      "vision_request" -> {
        val epoch = connectionGeneration.get()
        val requestId = event["requestId"]!!.jsonPrimitive.content
        scope.launch {
          runCatching {
            check(mutable.value.visualEnabled)
            val frame = withTimeout(1800) { captureFrame?.invoke() ?: error("camera_unavailable") }
            val jpeg = encodeLiveJpeg(frame.bytes)
            val age = (System.currentTimeMillis() - frame.capturedAt).coerceAtLeast(0)
            check(age <= 2000)
            if (epoch == connectionGeneration.get() && mutable.value.connected) send("frame", "requestId" to JsonPrimitive(requestId), "jpeg" to JsonPrimitive(Base64.encodeToString(jpeg, Base64.NO_WRAP)), "capturedAt" to JsonPrimitive(frame.capturedAt), "ageMs" to JsonPrimitive(age))
          }.onFailure { if (epoch == connectionGeneration.get()) mutable.update { it.copy(notice = "未取得本次新画面，请开启镜头或稍后重试。") } }
        }
      }
      "vision_observed" -> mutable.update { it.copy(visualDescription = event["description"]!!.jsonPrimitive.content) }
      "turn_started" -> { stopPlayback(); firstAudioElapsedMs = 0L; firstAudioReceivedElapsedMs = 0L; mutable.update { it.copy(answer = "", notice = null, turnId = event["turnId"]!!.jsonPrimitive.content, turnCompleted = false, transcript = event["query"]!!.jsonPrimitive.content, route = event["route"]!!.jsonPrimitive.content, error = null, hostTimingsJson = "") }; observedTurns.incrementAndGet() }
      "transcript" -> mutable.update { it.copy(transcript = event["text"]!!.jsonPrimitive.content) }
      "input_status" -> {
        val id = event["inputId"]?.jsonPrimitive?.longOrNull ?: return
        val status = event["status"]?.jsonPrimitive?.contentOrNull ?: return
        mutable.update { it.copy(inputReceipt = it.inputReceipt.update(id, status)) }
      }
      "input_health" -> mutable.update { it.copy(inputDiagnosticsJson = event["diagnostics"]?.toString().orEmpty()) }
      "recognition_comparison" -> {
        val id = event["inputId"]?.jsonPrimitive?.longOrNull ?: return
        val selected = event["selected"]?.jsonPrimitive?.contentOrNull ?: return
        val alternative = event["alternative"]?.jsonPrimitive?.contentOrNull ?: return
        mutable.update { it.copy(inputReceipt = it.inputReceipt.compare(id, selected, alternative)) }
      }
      "text_delta" -> mutable.update { it.copy(answer = it.answer + event["text"]!!.jsonPrimitive.content) }
      "audio" -> playbackGate.current(playbackEpoch) { if (firstAudioReceivedElapsedMs == 0L) firstAudioReceivedElapsedMs = android.os.SystemClock.elapsedRealtime(); playbackDone = false; val rate = event["sampleRate"]!!.jsonPrimitive.int; check(rate in 8000..48000); val bytes = Base64.decode(event["pcm"]!!.jsonPrimitive.content, Base64.DEFAULT); check(bytes.size <= 192000); if (ai.openclaw.clawsense.BuildConfig.DEBUG) validationAudioObserver?.invoke(bytes, rate); if (!audio.trySend(Audio(playbackEpoch, bytes, rate, event["seq"]!!.jsonPrimitive.long)).isSuccess) { interrupt(); fail("播放队列已满，文字已保留。") } }
      "interrupted" -> stopPlayback()
      "context_invalidated" -> { stopPlayback(); mutable.update { it.copy(transcript = "", answer = "", workResults = "", workJson = "[]", historyText = "", visualDescription = "", inputReceipt = LiveInputReceipt(), notice = "来源或权限已变化，旧回答已清除，请重新提问。") } }
      "work_updated" -> refreshResults()
      "task_queued" -> { mutable.update { it.copy(notice = "工作已排队，可以继续交流；完成后请复核成果。") }; refreshResults() }
      "task_updated" -> { mutable.update { it.copy(notice = "工作状态已更新；取消不会撤回此前已发生的外部动作。") }; refreshResults() }
      "completed" -> playbackGate.current(playbackEpoch) { mutable.update { it.copy(turnCompleted = true, hostTimingsJson = event["timings"]?.toString().orEmpty()) }; if (event["workItemId"] is JsonPrimitive && event["workItemId"] != JsonNull) refreshResults(); playbackDone = true; if (audio.isEmpty) scheduleFinish() }
      "client_control" -> if (event["command"]?.jsonPrimitive?.content == "stop_sensing") ai.openclaw.clawsense.service.SensorServiceController.stop(context)
      "persona_saved" -> mutable.update { it.copy(configuring = false, personaJson = event["persona"].toString(), notice = liveNoticeMessage("persona_saved")) }
      "configuration_required" -> mutable.update { it.copy(error = liveFailureMessage(event["code"]?.jsonPrimitive?.content)) }
      "error" -> { stopPlayback(); mutable.update { it.copy(configuring = false, answer = if (event["answerPreserved"]?.jsonPrimitive?.booleanOrNull == false) "" else it.answer, visualDescription = if (event["code"]?.jsonPrimitive?.content?.startsWith("current_frame_") == true) "" else it.visualDescription, error = liveFailureMessage(event["code"]?.jsonPrimitive?.content), diagnosticCode = event["code"]?.jsonPrimitive?.content?.take(100), inputDiagnosticsJson = event["inputDiagnostics"]?.toString().orEmpty()) } }
      "notice" -> mutable.update { it.copy(notice = liveNoticeMessage(event["code"]?.jsonPrimitive?.content)) }
      "request_replayed" -> { mutable.update { it.copy(notice = "该请求已接收，不会重复执行。请先查看宿主工作与成果。") }; refreshResults() }
    }
  }
  fun feed(pcm: ByteArray) {
    inputFrames.incrementAndGet()
    var power = 0.0
    for (i in 0 until pcm.size - 1 step 2) { val sample = ((pcm[i].toInt() and 255) or (pcm[i + 1].toInt() shl 8)).toShort().toDouble() / 32768.0; power += sample * sample }
    inputRmsMax = maxOf(inputRmsMax, kotlin.math.sqrt(power / maxOf(1, pcm.size / 2)))
    if (!mutable.value.connected || mutable.value.configuring) return
    val ws = socket ?: return
    if (ws.queueSize() > 128000) { fail("网络发送积压，已停止 Live，请重连。") ; return }
    if (ws.send(pcm.toByteString()) && !mutable.value.inputReady) mutable.update { it.copy(inputReady = it.connected) }
  }
  fun text(value: String, requestId: String = java.util.UUID.randomUUID().toString(), agent: String = "dsh") { if (value.isNotBlank() && !mutable.value.configuring) send("text", "text" to JsonPrimitive(value), "requestId" to JsonPrimitive(requestId), "agent" to JsonPrimitive(agent)) }
  fun cancelTask(id: String) { send("task_cancel", "workItemId" to JsonPrimitive(id)) }
  fun resumeTask(id: String) { send("task_resume", "workItemId" to JsonPrimitive(id)) }
  fun refreshWork() { refreshResults() }
  fun reviewTask(resultId: String, revision: Int, accept: Boolean) { scope.launch {
    runCatching { AppGraph.digital(context).reviewResult(resultId, revision, accept); refreshResults() }
      .onFailure { error -> mutable.update { it.copy(notice = "成果尚未确认：${error.message ?: "请连接同一资料库的主手机身份后重试"}") } }
  } }
  fun refreshHistory(query: String = "") { val epoch = connectionGeneration.get(); scope.launch {
    runCatching {
      val session = AppGraph.repository(context).requireSession()
      val url = (session.uploadBaseUrl.trimEnd('/') + "/live-history?query=" + java.net.URLEncoder.encode(query, "UTF-8"))
      client.newCall(Request.Builder().url(url).header("Authorization", "Bearer ${session.deviceSecret}").build()).execute().use { response ->
        check(response.isSuccessful)
        val history = json.parseToJsonElement(response.body!!.string()).jsonObject["history"]!!.jsonArray
        val text = history.joinToString("\n\n") { row -> val m = row.jsonObject; val at = m["at"]?.jsonPrimitive?.longOrNull ?: 0L; java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(at)) + (if (m["role"]?.jsonPrimitive?.content == "user") " · 你说（未确认）" else " · 助手回复") + (if (m["sourceState"]?.jsonPrimitive?.content == "stale") " · 来源已更新，勿直接复用" else "") + "\n" + m["content"]!!.jsonPrimitive.content }
        if (epoch == connectionGeneration.get()) mutable.update { it.copy(historyText = text.ifBlank { "没有找到当前获准的近期记录。" }) }
      }
    }.onFailure { if (epoch == connectionGeneration.get()) mutable.update { it.copy(historyText = "历史暂时无法读取，请检查连接。") } }
  } }
  private fun refreshResults() { val epoch = connectionGeneration.get(); scope.launch {
    runCatching { val session = AppGraph.repository(context).requireSession(); val request = Request.Builder().url(session.uploadBaseUrl.trimEnd('/') + "/live-result").header("Authorization", "Bearer ${session.deviceSecret}").build()
      client.newCall(request).execute().use { response -> if (response.isSuccessful) { val result = json.parseToJsonElement(response.body!!.string()).jsonObject["results"]!!.jsonArray
        val display = result.take(5).joinToString("\n\n") { item -> val row = item.jsonObject; val files = row["files"]?.jsonArray.orEmpty(); val review = when (row["reviewStatus"]?.jsonPrimitive?.contentOrNull) { "accepted" -> "本人已接受"; "rejected" -> "本人已拒绝"; else -> "待本人复核" }; liveWorkStatusLabel(row["status"]!!.jsonPrimitive.content) + (if (row["stale"]?.jsonPrimitive?.booleanOrNull == true) " · 来源已变化，待复核" else " · $review") + "\n" + (row["resultText"]?.jsonPrimitive?.content ?: row["failure"]?.jsonPrimitive?.content.orEmpty()) + files.joinToString("") { f -> "\n\n" + f.jsonObject["name"]!!.jsonPrimitive.content + "\n" + f.jsonObject["content"]!!.jsonPrimitive.content } }
        if (epoch == connectionGeneration.get()) mutable.update { it.copy(workResults = display, workJson = result.toString()) }
      } }
    }
  } }
  fun interrupt() { gate.interrupt(); stopPlayback(); send("interrupt") }
  fun setPersona(value: String) {
    runCatching {
      val data = json.parseToJsonElement(value).jsonObject
      if (mutable.value.configuring) return@runCatching
      if (mutable.value.connected) { configurationGeneration.incrementAndGet(); mutable.update { it.copy(configuring = true, backgroundPreparing = false, inputReceipt = LiveInputReceipt()) }; interrupt(); send("persona", "persona" to data); return@runCatching }
      if (mutable.value.connecting || mutable.value.configuring) return@runCatching
      val version = configurationGeneration.incrementAndGet()
      mutable.update { it.copy(configuring = true, backgroundPreparing = false, error = null, inputReceipt = LiveInputReceipt()) }
      scope.launch {
        runCatching {
          val session = AppGraph.repository(context).requireSession()
          val request = Request.Builder().url(session.uploadBaseUrl.trimEnd('/') + "/live").header("Authorization", "Bearer ${session.deviceSecret}")
            .put(buildJsonObject { put("persona", data) }.toString().toRequestBody("application/json".toMediaType())).build()
          client.newCall(request).execute().use { response ->
            check(response.isSuccessful)
            val saved = json.parseToJsonElement(response.body!!.string()).jsonObject["persona"].toString()
            if (version == configurationGeneration.get()) mutable.update { it.copy(configuring = false, personaJson = saved, notice = liveNoticeMessage("persona_saved")) }
          }
        }.onFailure { if (version == configurationGeneration.get()) mutable.update { it.copy(configuring = false, error = "设置尚未保存，请检查连接后重试。") } }
      }
    }
      .onFailure { mutable.update { it.copy(error = "人格 JSON 格式不正确") } }
  }
  private fun send(type: String, vararg data: Pair<String, JsonElement>) { socket?.send(buildJsonObject { put("type", type); data.forEach { put(it.first, it.second) } }.toString()) }
  private fun stopPlayback() {
    val requested = android.os.SystemClock.elapsedRealtime()
    var gateMs = 0L; var pauseMs = 0L; var flushMs = 0L; var pauseCompleted: Long? = null
    playbackGate.cancel {
      gateMs = android.os.SystemClock.elapsedRealtime() - requested
      playbackFinishJob?.cancel(); playbackFinishJob = null
      playbackDone = false
      while (audio.tryReceive().isSuccess) { }
      runCatching {
        val at = android.os.SystemClock.elapsedRealtime()
        track?.let { it.pause(); pauseCompleted = android.os.SystemClock.elapsedRealtime() }
        pauseMs = android.os.SystemClock.elapsedRealtime() - at
        val flushAt = android.os.SystemClock.elapsedRealtime(); track?.flush()
        flushMs = android.os.SystemClock.elapsedRealtime() - flushAt
      }
      playbackProgress.reset()
      mutable.update { it.copy(speaking = false) }
      send("playback", "active" to JsonPrimitive(false))
    }
    lastStopElapsedMs = android.os.SystemClock.elapsedRealtime()
    lastStopRequestedElapsedMs = requested; lastStopGateWaitMs = gateMs; lastPauseCallMs = pauseMs; lastFlushCallMs = flushMs
    stopTimings.add(PlaybackStopTiming(requested,pauseCompleted,lastStopElapsedMs,gateMs,pauseMs,flushMs))
    if (stopTimings.size > 100) stopTimings.removeAt(0)
    pauseTimes.add(lastStopElapsedMs); if (pauseTimes.size > 100) pauseTimes.removeAt(0)
    suppressAmbientUntil = System.currentTimeMillis() + 1200
  }
  private fun fail(message: String, code: String? = null) {
    connectionDeadline?.cancel(); connectionDeadline = null
    audioManager.abandonAudioFocusRequest(focus)
    connectionGeneration.incrementAndGet()
    connectJob?.cancel(); connectJob = null
    stopPlayback(); socket?.cancel(); socket = null
    playbackGate.release { runCatching { track?.release() }; track = null; playerGeneration = -1L }
    mutable.update { it.copy(connected = false, connecting = false, backgroundPreparing = false, inputReady = false, configuring = false, inputReceipt = LiveInputReceipt(), error = if (it.diagnosticCode == "audio_backpressure") it.error ?: message else message, diagnosticCode = it.diagnosticCode ?: code) }
  }
  fun disconnect() {
    validationAudioObserver = null
    configurationGeneration.incrementAndGet()
    connectionDeadline?.cancel(); connectionDeadline = null
    audioManager.abandonAudioFocusRequest(focus)
    connectionGeneration.incrementAndGet(); connectJob?.cancel(); connectJob = null
    socket?.close(1000, null); socket = null; stopPlayback()
    playbackGate.release { runCatching { track?.release() }; track = null; playerGeneration = -1L }
    mutable.update { it.copy(connected = false, connecting = false, backgroundPreparing = false, inputReady = false, configuring = false, inputReceipt = LiveInputReceipt()) }
  }
}
