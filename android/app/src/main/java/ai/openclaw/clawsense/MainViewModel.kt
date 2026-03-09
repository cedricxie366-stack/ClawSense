package ai.openclaw.clawsense

import ai.openclaw.clawsense.data.DeviceSession
import ai.openclaw.clawsense.data.DeviceSessionRepository
import ai.openclaw.clawsense.data.ServiceRuntimeStatus
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class MainViewModel(
  private val repository: DeviceSessionRepository,
) : ViewModel() {
  private val formState = MutableStateFlow(
    FormState(
      deviceName = android.os.Build.MODEL.ifBlank { "ClawSense Android" },
    ),
  )

  val uiState: StateFlow<MainUiState> = combine(
    repository.session,
    repository.serviceEnabled,
    repository.runtimeStatus,
    formState,
  ) { session, serviceEnabled, runtimeStatus, form ->
    MainUiState(
      session = session,
      serviceEnabled = serviceEnabled,
      runtimeStatus = runtimeStatus,
      isBusy = form.isBusy,
      statusMessage = form.statusMessage,
      setupCode = form.setupCode,
      manualHost = form.manualHost,
      manualToken = form.manualToken,
      deviceName = form.deviceName,
    )
  }.stateIn(
    viewModelScope,
    SharingStarted.WhileSubscribed(5_000),
    MainUiState(),
  )

  fun onSetupCodeChanged(value: String) {
    formState.update { it.copy(setupCode = value) }
  }

  fun onManualHostChanged(value: String) {
    formState.update { it.copy(manualHost = value) }
  }

  fun onManualTokenChanged(value: String) {
    formState.update { it.copy(manualToken = value) }
  }

  fun onDeviceNameChanged(value: String) {
    formState.update { it.copy(deviceName = value) }
  }

  fun onScannerResult(value: String) {
    formState.update { it.copy(setupCode = value, statusMessage = "已读取二维码，请点击配对。") }
  }

  fun pairFromSetupCode() {
    val snapshot = formState.value
    if (snapshot.setupCode.isBlank()) {
      formState.update { it.copy(statusMessage = "请先扫码，或粘贴引导码。") }
      return
    }
    runPairing {
      repository.pairWithSetupCode(
        setupCode = snapshot.setupCode,
        deviceName = snapshot.deviceName.ifBlank { "ClawSense Android" },
        appVersion = BuildConfig.VERSION_NAME,
      )
    }
  }

  fun pairManual() {
    val snapshot = formState.value
    if (snapshot.manualHost.isBlank() || snapshot.manualToken.isBlank()) {
      formState.update { it.copy(statusMessage = "请填写 Host 和 Token。") }
      return
    }
    runPairing {
      repository.pairManual(
        host = snapshot.manualHost,
        token = snapshot.manualToken,
        deviceName = snapshot.deviceName.ifBlank { "ClawSense Android" },
        appVersion = BuildConfig.VERSION_NAME,
      )
    }
  }

  fun setServiceEnabled(enabled: Boolean) {
    repository.setServiceEnabled(enabled)
  }

  fun updateRuntimeStatus(status: ServiceRuntimeStatus) {
    repository.updateRuntimeStatus(status)
  }

  fun clearSession() {
    repository.clearSession()
    formState.update {
      it.copy(
        statusMessage = "设备配对已清除。",
        setupCode = "",
        manualToken = "",
      )
    }
  }

  fun setStatus(message: String?) {
    formState.update { it.copy(statusMessage = message) }
  }

  private fun runPairing(block: suspend () -> DeviceSession) {
    viewModelScope.launch {
      formState.update { it.copy(isBusy = true, statusMessage = "正在和 ClawSense 服务端握手…") }
      runCatching { block() }
        .onSuccess { session ->
          repository.setServiceEnabled(false)
          formState.update {
            it.copy(
              isBusy = false,
              statusMessage = "配对成功：${session.deviceId.take(8)}…",
              manualHost = session.host,
              manualToken = "",
            )
          }
        }
        .onFailure { error ->
          formState.update {
            it.copy(
              isBusy = false,
              statusMessage = error.message ?: "配对失败，请检查 Host / Token。",
            )
          }
        }
    }
  }
}

data class MainUiState(
  val session: DeviceSession? = null,
  val serviceEnabled: Boolean = false,
  val runtimeStatus: ServiceRuntimeStatus = ServiceRuntimeStatus(),
  val isBusy: Boolean = false,
  val statusMessage: String? = null,
  val setupCode: String = "",
  val manualHost: String = "",
  val manualToken: String = "",
  val deviceName: String = "ClawSense Android",
)

private data class FormState(
  val isBusy: Boolean = false,
  val statusMessage: String? = null,
  val setupCode: String = "",
  val manualHost: String = "",
  val manualToken: String = "",
  val deviceName: String = "ClawSense Android",
)
