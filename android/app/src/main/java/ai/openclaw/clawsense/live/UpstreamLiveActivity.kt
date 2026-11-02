package ai.openclaw.clawsense.live

import android.Manifest
import android.os.Bundle
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.ui.ClawSenseTheme
import ai.pipecat.client.PipecatClientOptions
import ai.pipecat.client.PipecatEventCallbacks
import ai.pipecat.client.small_webrtc_transport.*
import ai.pipecat.client.types.*
import kotlinx.coroutines.*

/** Foreground-only trial. The SDK owns the microphone and playout together.
 * Leaving this Activity releases them; legacy capture cannot start concurrently. */
class UpstreamLiveActivity : ComponentActivity() {
  companion object {
    @Volatile private var ownsMedia = false
    private val releasing = java.util.concurrent.atomic.AtomicInteger()
    val active: Boolean get() = ownsMedia || releasing.get() > 0
    @Volatile private var stopCurrent: (() -> Unit)? = null
    fun stopAll() { stopCurrent?.invoke() }
  }
  private var client: PipecatClientSmallWebRTC? = null
  private var generation = 0L
  private var deadline: Job? = null
  private var pending: Job? = null
  private var status by mutableStateOf("尚未开启")
  private var answer by mutableStateOf("")
  private var transcript by mutableStateOf("")
  private var connected by mutableStateOf(false)
  private var busy by mutableStateOf(false)
  private var closing by mutableStateOf(false)
  private var camera by mutableStateOf(false)
  private val audioManager by lazy { getSystemService(AUDIO_SERVICE) as android.media.AudioManager }
  private var ownsAudio = false
  private var previousSpeaker = false
  private var previousMode = android.media.AudioManager.MODE_NORMAL
  private val focus by lazy {
    android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setOnAudioFocusChangeListener { change -> if (change < 0 && ownsAudio) runOnUiThread { stop(); status = "其他音频已接管，Live 已结束。" } }.build()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The official libwebrtc module uses USAGE_VOICE_COMMUNICATION, so volume
    // buttons must control its call stream rather than the old media player.
    volumeControlStream = android.media.AudioManager.STREAM_VOICE_CALL
    setContent { ClawSenseTheme {
      val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.RECORD_AUDIO] == true && (!camera || result[Manifest.permission.CAMERA] == true)) start()
        else status = "需要允许本次麦克风／镜头使用。"
      }
      Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Live 对照版", style = MaterialTheme.typography.headlineSmall)
        Text("手机看、听和播放，自有电脑理解并回答。沿用当前对话的公开／本人设置。离开此页即结束；本轮最多两分钟。")
        Text(status)
        Row { Checkbox(camera, { camera = it }, enabled = !busy && !connected); Text("传送当前镜头，仅在相关提问时分析") }
        Button(enabled = !closing && (!busy || active), onClick = {
          if (active) stop() else {
            val required = if (camera) arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA) else arrayOf(Manifest.permission.RECORD_AUDIO)
            if (required.all { ContextCompat.checkSelfPermission(this@UpstreamLiveActivity, it) == PackageManager.PERMISSION_GRANTED }) start()
            else permission.launch(required)
          }
        }) { Text(if (closing) "正在结束…" else if (active) "结束 Live" else "开启 Live") }
        if (connected) OutlinedButton(onClick = { client?.sendClientMessage("stop-speaking") }) { Text("停止朗读") }
        if (transcript.isNotBlank()) Text("你：$transcript")
        if (answer.isNotBlank()) Text(answer)
        TextButton(onClick = { stop(); finish() }) { Text("返回") }
      }
    } }
  }

  private fun start() {
    if (active || busy) return
    val old = AppGraph.live(this).state.value
    if (old.connected || old.connecting || AppGraph.repository(this).runtimeStatus.value.phase in listOf(ai.openclaw.clawsense.data.ServicePhase.RUNNING, ai.openclaw.clawsense.data.ServicePhase.STARTING, ai.openclaw.clawsense.data.ServicePhase.STOPPING)) {
      status = "请先结束当前感知或 Live，再开启对照版。"; return
    }
    if (audioManager.mode != android.media.AudioManager.MODE_NORMAL || audioManager.requestAudioFocus(focus) != android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      status = "通话或其他音频正在占用，请结束后再开启。"; return
    }
    previousMode = audioManager.mode; previousSpeaker = audioManager.isSpeakerphoneOn
    ownsAudio = true; audioManager.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
    val epoch = ++generation
    ownsMedia = true; busy = true; status = "正在准备并连接电脑…"; answer = ""; transcript = ""
    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    stopCurrent = { runOnUiThread { stop() } }
    pending = lifecycleScope.launch {
      try {
        val session = AppGraph.repository(this@UpstreamLiveActivity).requireSession()
        if (epoch != generation) return@launch
        val callbacks = object : PipecatEventCallbacks() {
          private fun update(action: () -> Unit) { runOnUiThread { if (epoch == generation) action() } }
          override fun onBackendError(message: String) = update { stop(); status = "对话连接失败，请检查电脑对照服务。" }
          override fun onDisconnected() = update { stop() }
          override fun onBotReady(data: BotReadyData) = update {
            status = "正在开启麦克风…"
            client?.enableMic(true)?.withCallback { result -> update {
              if (result.errorOrNull != null) { stop(); status = "麦克风未能开启，会话已结束。" }
              else {
                busy = false; connected = true; status = "正在听你说"
                if (camera) {
                  client?.updateCam(SmallWebRTCTransport.Cameras.Rear.id)
                  client?.enableCam(true)?.withCallback { cameraResult -> update {
                    if (cameraResult.errorOrNull != null) { stop(); status = "镜头未能开启，会话已结束。" }
                  } }
                }
              }
            } }
          }
          override fun onBotStartedSpeaking() = update { status = "正在说话，你可以打断" }
          override fun onBotStoppedSpeaking() = update { status = "正在听你说" }
          override fun onUserTranscript(data: Transcript) = update { transcript = data.text }
          override fun onUserStartedSpeaking() = update { answer = "" }
          override fun onBotOutput(data: BotOutputData) = update {
            if (data.spokenStatus == null || data.spokenStatus == BotOutputData.SpokenStatus.New) answer += data.text
          }
        }
        val transport = SmallWebRTCTransport(applicationContext, iceConfig = IceConfig(iceServers = emptyList()))
        val current = PipecatClientSmallWebRTC(transport, PipecatClientOptions(callbacks, enableMic = false, enableCam = false))
        client = current
        val externalOutput = audioManager.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).any {
          it.type in listOf(android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET, android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            android.media.AudioDeviceInfo.TYPE_USB_HEADSET, android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, android.media.AudioDeviceInfo.TYPE_BLE_HEADSET)
        }
        if (!externalOutput) current.updateMic(SmallWebRTCTransport.AudioDevices.Speakerphone.id)
        current.connect(SmallWebRTCTransportConnectParams(APIRequest(
          endpoint = session.uploadBaseUrl.trimEnd('/') + "/live-upstream/offer",
          requestData = Value.Object("vision" to Value.Bool(camera)),
          headers = mapOf("Authorization" to "Bearer ${session.deviceSecret}"), timeoutMs = 90000
        ), iceConfig = IceConfig(iceServers = emptyList()))).withCallback { result ->
          runOnUiThread { if (epoch == generation && result.errorOrNull != null) { stop(); status = "连接失败，请确认手机与电脑的局域网可达。" } }
        }
        deadline = lifecycleScope.launch { delay(120000); if (epoch == generation) { stop(); status = "本轮两分钟已结束。" } }
      } catch (_: Exception) { if (epoch == generation) { stop(); status = "无法开启，请先完成设备配对。" } }
    }
  }
  private fun stop() {
    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    generation++; deadline?.cancel(); deadline = null
    val previous = client; client = null
    if (previous != null) {
      closing = true
      releasing.incrementAndGet()
      previous.disconnect().withCallback { try { previous.release() } finally { releaseAudio(); releasing.decrementAndGet(); runOnUiThread { closing = false } } }
    } else if (releasing.get() == 0) releaseAudio()
    ownsMedia = false; busy = false; connected = false; stopCurrent = null; status = "Live 已结束"
  }
  private fun releaseAudio() {
    if (!ownsAudio) return
    ownsAudio = false
    runCatching { audioManager.isSpeakerphoneOn = previousSpeaker; audioManager.mode = previousMode; audioManager.abandonAudioFocusRequest(focus) }
  }
  override fun onStop() { stop(); super.onStop() }
  override fun onDestroy() { pending?.cancel(); stop(); super.onDestroy() }
}
