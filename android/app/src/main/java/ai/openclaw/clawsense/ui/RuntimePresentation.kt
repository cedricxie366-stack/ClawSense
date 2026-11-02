package ai.openclaw.clawsense.ui

import ai.openclaw.clawsense.BuildConfig
import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.*
import android.Manifest
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal data class PermissionSnapshot(val camera: Boolean = false, val microphone: Boolean = false, val notifications: Boolean = false) {
  val canSense get() = notifications && (camera || microphone)
}
internal data class HostWarning(val title: String, val detail: String, val action: String, val blocksStart: Boolean = true)
internal fun permissionSnapshot(context: android.content.Context) = PermissionSnapshot(
  hasPermission(context, Manifest.permission.CAMERA), hasPermission(context, Manifest.permission.RECORD_AUDIO),
  Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPermission(context, Manifest.permission.POST_NOTIFICATIONS),
)
internal fun captureModeLabel(mode: CaptureMode) = when (mode) {
  CaptureMode.FULL -> "音频与图片"; CaptureMode.AUDIO_ONLY -> "仅音频"; CaptureMode.IMAGE_ONLY -> "仅图片"; CaptureMode.NONE -> "尚未采集"
}
internal fun serviceLabel(state: MainUiState) = when {
  state.session == null -> "尚未连接"
  state.runtimeStatus.phase == ServicePhase.STARTING -> "正在开启感知"
  state.runtimeStatus.phase == ServicePhase.STOPPING -> "正在结束感知"
  state.runtimeStatus.phase == ServicePhase.RUNNING -> "正在感知 · ${captureModeLabel(state.runtimeStatus.mode)}"
  state.runtimeStatus.phase == ServicePhase.ERROR -> "感知出现异常"
  else -> "感知已停止"
}

internal fun formatTimestamp(timestamp: Long): String {
  return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(timestamp))
}

internal fun formatTimestampOrPlaceholder(timestamp: Long?, placeholder: String = "暂无"): String {
  return timestamp?.let(::formatTimestamp) ?: placeholder
}

internal fun formatRecentError(activity: ServiceActivitySnapshot): String {
  val message = activity.lastError ?: return "暂无错误"
  val occurredAt = activity.lastErrorAt?.let(::formatTimestamp)
  return if (occurredAt == null) {
    message
  } else {
    "$occurredAt · $message"
  }
}

internal fun formatVideoStatus(activity: ServiceActivitySnapshot): String {
  val status = activity.lastVideoStatus ?: return if (activity.lastVideoUploadAt != null) {
    "最近一次视频已上传。"
  } else {
    "暂无视频片段"
  }
  val occurredAt = activity.lastVideoStatusAt?.let(::formatTimestamp)
  return if (occurredAt == null) {
    status
  } else {
    "$occurredAt · $status"
  }
}

internal fun formatAnalysisQueueStatus(activity: ServiceActivitySnapshot): String {
  val queueDepth = activity.lastServerQueueDepth
  val queueText = queueDepth?.let { "，深度 $it" } ?: ""
  return when (activity.lastAnalysisQueued) {
    true -> "已进入后台分析队列$queueText"
    false -> "媒体已保存，等待补分析$queueText"
    null -> "暂无队列状态"
  }
}

internal fun buildRecentEventDiagnostics(message: String, uiState: MainUiState): String {
  return buildString {
    appendLine("ClawSense 最近事件")
    appendLine("generatedAt=${formatTimestamp(System.currentTimeMillis())}")
    appendLine("appVersion=${BuildConfig.VERSION_NAME}")
    appendLine("message=$message")
    appendLine("busy=${uiState.isBusy}")
    appendLine("serviceEnabled=${uiState.serviceEnabled}")
    appendLine("runtime=${uiState.runtimeStatus.phase}/${uiState.runtimeStatus.mode}")
    appendLine("assistant=${uiState.assistant.phase}/${uiState.assistant.mode}")
    uiState.assistant.lastError?.let { appendLine("assistantLastError=$it") }
    uiState.serviceActivity.lastError?.let { appendLine("serviceLastError=$it") }
    appendLine("pendingUploads=${uiState.serviceActivity.pendingUploads}")
  }
}

internal fun buildRecentActivityDiagnostics(
  uiState: MainUiState,
  permissions: PermissionSnapshot,
  hostWarning: HostWarning?,
): String {
  val activity = uiState.serviceActivity
  val session = uiState.session
  return buildString {
    appendLine("ClawSense 最近活动诊断")
    appendLine("generatedAt=${formatTimestamp(System.currentTimeMillis())}")
    appendLine("appVersion=${BuildConfig.VERSION_NAME}")
    appendLine("deviceName=${uiState.deviceName}")
    appendLine("paired=${session != null}")
    appendLine("deviceId=${session?.deviceId ?: "none"}")
    appendLine("host=${session?.host ?: "none"}")
    appendLine("uploadBaseUrl=${session?.uploadBaseUrl ?: "none"}")
    appendLine("hostWarning=${hostWarning?.title ?: "none"}")
    appendLine("hostWarningAction=${hostWarning?.action ?: "none"}")
    appendLine("serviceEnabled=${uiState.serviceEnabled}")
    appendLine("runtimePhase=${uiState.runtimeStatus.phase}")
    appendLine("runtimeMode=${uiState.runtimeStatus.mode}")
    appendLine("runtimeUpdatedAt=${formatTimestamp(uiState.runtimeStatus.updatedAt)}")
    appendLine("runtimeLastError=${uiState.runtimeStatus.lastError ?: "none"}")
    appendLine("permissions.camera=${permissions.camera}")
    appendLine("permissions.microphone=${permissions.microphone}")
    appendLine("permissions.notifications=${permissions.notifications}")
    appendLine("lastAudioUploadAt=${formatTimestampOrPlaceholder(activity.lastAudioUploadAt)}")
    appendLine("lastImageUploadAt=${formatTimestampOrPlaceholder(activity.lastImageUploadAt)}")
    appendLine("lastVideoUploadAt=${formatTimestampOrPlaceholder(activity.lastVideoUploadAt)}")
    appendLine("videoStatus=${formatVideoStatus(activity)}")
    appendLine("videoCaptureInProgress=${activity.videoCaptureInProgress}")
    appendLine("analysisQueue=${formatAnalysisQueueStatus(activity)}")
    appendLine("lastUploadStored=${activity.lastUploadStored ?: "unknown"}")
    appendLine("lastAnalysisQueued=${activity.lastAnalysisQueued ?: "unknown"}")
    appendLine("lastServerQueueDepth=${activity.lastServerQueueDepth ?: "unknown"}")
    appendLine("pendingUploads=${activity.pendingUploads}")
    appendLine("recentError=${formatRecentError(activity)}")
    appendLine("statusMessage=${uiState.statusMessage ?: "none"}")
    appendLine("assistantPhase=${uiState.assistant.phase}")
    appendLine("assistantMode=${uiState.assistant.mode}")
    appendLine("assistantQuery=${uiState.assistant.queryText ?: "none"}")
    appendLine("assistantAnswer=${uiState.assistant.answerText ?: "none"}")
    appendLine("assistantSpoken=${uiState.assistant.answerSpokenText ?: "none"}")
    appendLine("assistantLastError=${uiState.assistant.lastError ?: "none"}")
  }
}

internal fun resolveSessionHostWarning(session: DeviceSession): HostWarning? {
  val badHost = findUnreachableHost(session.host) ?: findUnreachableHost(session.uploadBaseUrl)
  return badHost?.let {
    val localLoopback = it == "localhost" || it == "127.0.0.1" || it == "::1"
    val debugLoopbackAllowed = BuildConfig.DEBUG && localLoopback
    HostWarning(
      title = if (debugLoopbackAllowed) "当前配对 Host 需要 USB 反向代理" else "当前配对 Host 不可被手机访问",
      detail = if (debugLoopbackAllowed) {
        "当前会话指向 $it。Debug 调试时只有在 adb reverse tcp:<port> tcp:<port> 生效时才可访问；真机离开 USB 后会上传失败。"
      } else {
        "当前会话仍指向 $it。旧手机访问自己的 127.0.0.1 / localhost / lan 时不会到达 OpenClaw 主机，所以音频、图片、视频都会进入失败重试。"
      },
      action = if (debugLoopbackAllowed) {
        "本地调试请确认 adb reverse 已开启；云端/局域网使用请重新扫码或手动填写可访问 Host + 新 Setup Token。"
      } else {
        "请在“设置 → 感知设备连接”里重新扫码，或手动填写云端/局域网可访问的 Host + 新 Setup Token。"
      },
      blocksStart = !debugLoopbackAllowed,
    )
  }
}

internal fun findUnreachableHost(url: String): String? {
  val host = runCatching {
    URI(url).host?.trim()?.lowercase()?.removePrefix("[")?.removeSuffix("]")
  }.getOrNull() ?: return null
  return when (host) {
    "lan", "localhost", "127.0.0.1", "0.0.0.0", "::", "::1", "*" -> host
    else -> null
  }
}

internal fun requiredSensorPermissions(): List<String> {
  return buildList {
    add(Manifest.permission.CAMERA)
    add(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      add(Manifest.permission.POST_NOTIFICATIONS)
    }
  }
}

internal fun hasAnyCapturePermission(context: android.content.Context): Boolean {
  return hasPermission(context, Manifest.permission.CAMERA) ||
    hasPermission(context, Manifest.permission.RECORD_AUDIO)
}

internal fun canStartSensing(context: android.content.Context): Boolean {
  return (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPermission(context, Manifest.permission.POST_NOTIFICATIONS)) &&
    hasAnyCapturePermission(context)
}

internal fun hasPermission(context: android.content.Context, permission: String): Boolean {
  if (permission == Manifest.permission.POST_NOTIFICATIONS && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
    return true
  }
  return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

