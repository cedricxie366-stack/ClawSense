package ai.openclaw.clawsense

import ai.openclaw.clawsense.data.DeviceSession
import ai.openclaw.clawsense.data.DeviceSessionRepository
import ai.openclaw.clawsense.data.AssistantInteractionSnapshot
import ai.openclaw.clawsense.data.CapturePreferences
import ai.openclaw.clawsense.data.ServiceActivitySnapshot
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
    repository.capturePreferences,
  ) { session, serviceEnabled, runtimeStatus, capturePreferences ->
    RuntimeBase(
      session = session,
      serviceEnabled = serviceEnabled,
      runtimeStatus = runtimeStatus,
      capturePreferences = capturePreferences,
    )
  }.let { runtimeBase ->
    combine(
      runtimeBase,
      repository.activitySnapshot,
      repository.assistantSnapshot,
    ) { base, activitySnapshot, assistantSnapshot ->
    RuntimeComposite(
      session = base.session,
      serviceEnabled = base.serviceEnabled,
      runtimeStatus = base.runtimeStatus,
      capturePreferences = base.capturePreferences,
      activitySnapshot = activitySnapshot,
      assistantSnapshot = assistantSnapshot,
    )
    }
  }.let { runtimeState ->
    combine(runtimeState, formState) { runtime, form ->
      MainUiState(
        session = runtime.session,
        serviceEnabled = runtime.serviceEnabled,
        runtimeStatus = runtime.runtimeStatus,
        capturePreferences = runtime.capturePreferences,
        serviceActivity = runtime.activitySnapshot,
        assistant = runtime.assistantSnapshot,
        isBusy = form.isBusy,
        statusMessage = form.statusMessage,
        setupCode = form.setupCode,
        manualHost = form.manualHost,
        manualToken = form.manualToken,
        deviceName = form.deviceName,
      )
    }
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

  fun pairFromSetupCode(preserveServiceEnabled: Boolean = false) {
    val snapshot = formState.value
    if (snapshot.setupCode.isBlank()) {
      formState.update { it.copy(statusMessage = "请先扫码，或粘贴引导码。") }
      return
    }
    runPairing(preserveServiceEnabled = preserveServiceEnabled) {
      repository.pairWithSetupCode(
        setupCode = snapshot.setupCode,
        deviceName = snapshot.deviceName.ifBlank { "ClawSense Android" },
        appVersion = BuildConfig.VERSION_NAME,
      )
    }
  }

  fun pairManual(preserveServiceEnabled: Boolean = false) {
    val snapshot = formState.value
    if (snapshot.manualHost.isBlank() || snapshot.manualToken.isBlank()) {
      formState.update { it.copy(statusMessage = "请填写 Host 和 Token。") }
      return
    }
    runPairing(preserveServiceEnabled = preserveServiceEnabled) {
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

  fun setAutoVideoEnabled(enabled: Boolean) {
    repository.setAutoVideoEnabled(enabled)
    formState.update {
      it.copy(
        statusMessage = if (enabled) {
          "自动视频已开启：检测到关键线索时会低频录制 6 秒片段。"
        } else {
          "自动视频已关闭，只保留手动录制。"
        },
      )
    }
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

  private fun runPairing(
    preserveServiceEnabled: Boolean = false,
    block: suspend () -> DeviceSession,
  ) {
    viewModelScope.launch {
      formState.update { it.copy(isBusy = true, statusMessage = "正在和 ClawSense 服务端握手…") }
      runCatching { block() }
        .onSuccess { session ->
          if (!preserveServiceEnabled) {
            repository.setServiceEnabled(false)
          }
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
  val capturePreferences: CapturePreferences = CapturePreferences(),
  val serviceActivity: ServiceActivitySnapshot = ServiceActivitySnapshot(),
  val assistant: AssistantInteractionSnapshot = AssistantInteractionSnapshot(),
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

private data class RuntimeBase(
  val session: DeviceSession?,
  val serviceEnabled: Boolean,
  val runtimeStatus: ServiceRuntimeStatus,
  val capturePreferences: CapturePreferences,
)

private data class RuntimeComposite(
  val session: DeviceSession?,
  val serviceEnabled: Boolean,
  val runtimeStatus: ServiceRuntimeStatus,
  val capturePreferences: CapturePreferences,
  val activitySnapshot: ServiceActivitySnapshot,
  val assistantSnapshot: AssistantInteractionSnapshot,
)
