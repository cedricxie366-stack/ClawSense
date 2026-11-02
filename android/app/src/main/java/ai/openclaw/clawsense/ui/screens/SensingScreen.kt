package ai.openclaw.clawsense.ui.screens

import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.ServicePhase
import ai.openclaw.clawsense.ui.*
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable internal fun SensingScreen(state: MainUiState, permissions: PermissionSnapshot, hostWarning: HostWarning?, onStart: () -> Unit, onStop: () -> Unit, onVideo: () -> Unit, open: (AppDestination) -> Unit) {
  val running = state.runtimeStatus.phase == ServicePhase.RUNNING
  val starting = state.runtimeStatus.phase == ServicePhase.STARTING
  val stopping = state.runtimeStatus.phase == ServicePhase.STOPPING
  PageColumn(Modifier.testTag("screen_sensing")) {
    Text(serviceLabel(state), style = MaterialTheme.typography.headlineSmall)
    Text(if (running) "${captureModeLabel(state.runtimeStatus.mode)}正在采集，随时可以停止。" else "开启后，环境记录会同步到已连接的主机。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    Button(onClick = {
      when {
        running || starting -> onStop()
        state.session == null || hostWarning?.blocksStart == true -> open(AppDestination.SENSOR_CONNECTION)
        else -> onStart()
      }
    }, enabled = !starting && !stopping && !state.isBusy, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("sensing_primary")) {
      Icon(if (running) Icons.Outlined.StopCircle else Icons.Outlined.PlayArrow, null)
      Spacer(Modifier.width(8.dp))
      Text(when { stopping -> "正在结束…"; starting -> "正在开启…"; running -> "停止感知"; state.session == null -> "连接感知设备"; hostWarning?.blocksStart == true -> "修复设备连接"; else -> "开启感知" })
    }
    hostWarning?.let { Notice(it.title, it.detail, "管理连接", error = it.blocksStart, onAction = { open(AppDestination.SENSOR_CONNECTION) }) }
    if (state.session != null && (!permissions.camera || !permissions.microphone || !permissions.notifications)) Notice("部分权限尚未开启", "可用权限决定采集模式。", "查看权限", onAction = { open(AppDestination.PERMISSIONS) })
    HorizontalDivider()
    SectionTitle("记录一段视频")
    Text("录制 6 秒画面，为当前记录补充动态细节。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedButton(onClick = onVideo, enabled = running && permissions.camera && hostWarning?.blocksStart != true && !state.serviceActivity.videoCaptureInProgress, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
      Icon(Icons.Outlined.Videocam, null); Spacer(Modifier.width(8.dp))
      Text(if (state.serviceActivity.videoCaptureInProgress) "正在录制或上传…" else "录制 6 秒视频片段")
    }
    Text(formatVideoStatus(state.serviceActivity), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    HorizontalDivider()
    SectionTitle("最近上传")
    DetailRow("音频", formatTimestampOrPlaceholder(state.serviceActivity.lastAudioUploadAt, "还没有音频记录"))
    DetailRow("图片", formatTimestampOrPlaceholder(state.serviceActivity.lastImageUploadAt, "还没有图片记录"))
    DetailRow("视频", formatTimestampOrPlaceholder(state.serviceActivity.lastVideoUploadAt, "还没有视频记录"))
    if (state.serviceActivity.pendingUploads > 0) Text("${state.serviceActivity.pendingUploads} 条记录等待补传")
    if (state.serviceActivity.lastError != null || state.runtimeStatus.lastError != null) Notice("最近有操作未完成", state.serviceActivity.lastError ?: state.runtimeStatus.lastError, "查看诊断", true) { open(AppDestination.DIAGNOSTICS) }
    TextButton(onClick = { open(AppDestination.DIAGNOSTICS) }) { Text("查看最近活动") }
  }
}
