package ai.openclaw.clawsense.data

import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class DeviceSessionRepository(
  private val store: SecureSessionStore,
  private val api: ClawSenseApi,
) {
  private val _session = MutableStateFlow(store.loadSession())
  private val _serviceEnabled = MutableStateFlow(store.loadServiceEnabled())
  private val _runtimeStatus = MutableStateFlow(store.loadRuntimeStatus())

  val session: StateFlow<DeviceSession?> = _session.asStateFlow()
  val serviceEnabled: StateFlow<Boolean> = _serviceEnabled.asStateFlow()
  val runtimeStatus: StateFlow<ServiceRuntimeStatus> = _runtimeStatus.asStateFlow()

  suspend fun pairWithSetupCode(
    setupCode: String,
    deviceName: String,
    appVersion: String,
  ): DeviceSession {
    val pairingSetup = SetupCodeParser.parse(setupCode)
      ?: throw IllegalArgumentException("二维码/引导码无法解析，请重新扫码。")
    return pairManual(
      host = pairingSetup.host,
      token = pairingSetup.token,
      deviceName = deviceName,
      appVersion = appVersion,
    )
  }

  suspend fun pairManual(
    host: String,
    token: String,
    deviceName: String,
    appVersion: String,
  ): DeviceSession {
    val session = api.pair(
      host = host,
      token = token,
      deviceName = deviceName,
      appVersion = appVersion,
      fingerprint = buildFingerprint(),
    )
    store.saveSession(session)
    _session.value = session
    return session
  }

  fun refresh() {
    _session.value = store.loadSession()
    _serviceEnabled.value = store.loadServiceEnabled()
    _runtimeStatus.value = store.loadRuntimeStatus()
  }

  fun requireSession(): DeviceSession {
    return _session.value ?: throw IllegalStateException("设备尚未配对")
  }

  fun clearSession() {
    store.clearSession()
    store.saveServiceEnabled(false)
    updateRuntimeStatus(ServiceRuntimeStatus())
    _session.value = null
    _serviceEnabled.value = false
  }

  fun setServiceEnabled(enabled: Boolean) {
    store.saveServiceEnabled(enabled)
    _serviceEnabled.value = enabled
  }

  fun updateRuntimeStatus(status: ServiceRuntimeStatus) {
    store.saveRuntimeStatus(status)
    _runtimeStatus.value = status
  }

  suspend fun uploadAudio(clip: CapturedAudioClip) {
    api.uploadAudio(requireSession(), clip)
  }

  suspend fun uploadImage(image: CapturedImageFrame) {
    api.uploadImage(requireSession(), image)
  }

  suspend fun sendHeartbeat(heartbeat: HeartbeatRequest): Int {
    return api.sendHeartbeat(requireSession(), heartbeat)
  }

  private fun buildFingerprint(): String {
    return listOf(Build.BRAND, Build.MODEL, Build.DEVICE, Build.VERSION.SDK_INT.toString())
      .joinToString(":")
  }
}
