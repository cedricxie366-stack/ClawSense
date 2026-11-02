package ai.openclaw.clawsense.ui.screens

import ai.openclaw.clawsense.BuildConfig
import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.DeviceSession
import ai.openclaw.clawsense.ui.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable internal fun SettingsScreen(state: MainUiState, primarySession: DeviceSession?, open: (AppDestination) -> Unit) {
  PageColumn(Modifier.testTag("screen_settings")) {
    SectionTitle("设备连接")
    SettingRow("感知设备连接", if (state.session == null) "未连接 · 用于采集与实时助手" else "已连接 · ${state.session.host}", Icons.Outlined.Sensors) { open(AppDestination.SENSOR_CONNECTION) }
    SettingRow("数字记忆连接", if (primarySession == null) "未连接 · 用于分享与记忆同步" else "已连接 · ${primarySession.host}", Icons.Outlined.Bookmarks) { open(AppDestination.DIGITAL_CONNECTION) }
    HorizontalDivider()
    SectionTitle("应用设置")
    SettingRow("权限", "相机、麦克风与通知", Icons.Outlined.Security) { open(AppDestination.PERMISSIONS) }
    SettingRow("感知偏好", "自动短视频", Icons.Outlined.Tune) { open(AppDestination.CAPTURE_PREFERENCES) }
    HorizontalDivider()
    SectionTitle("帮助与信息")
    SettingRow("诊断与最近活动", "上传状态、错误与诊断复制", Icons.Outlined.Info) { open(AppDestination.DIAGNOSTICS) }
    Text("ClawSense  ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

@Composable internal fun PermissionsScreen(permissions: PermissionSnapshot, request: (String) -> Unit, openSystemSettings: () -> Unit) {
  PageColumn {
    Text("按需授权，随时管理", style = MaterialTheme.typography.headlineSmall)
    Text("感知需要通知权限，以及至少一种采集权限。语音助手需要麦克风。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    listOf(
      Triple("相机", "用于拍照、短视频与扫码", android.Manifest.permission.CAMERA) to permissions.camera,
      Triple("麦克风", "用于环境音频与语音提问", android.Manifest.permission.RECORD_AUDIO) to permissions.microphone,
      *if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) arrayOf(Triple("通知", "显示后台感知运行状态", android.Manifest.permission.POST_NOTIFICATIONS) to permissions.notifications) else emptyArray(),
    ).forEach { (entry, granted) ->
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${entry.first} · ${if (granted) "已授权" else "未授权"}", style = MaterialTheme.typography.titleMedium)
        Text(entry.second, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!granted) OutlinedButton(onClick = { request(entry.third) }) { Text("授权${entry.first}") }
      }
      HorizontalDivider()
    }
    Text("如果系统不再显示授权弹窗，请在系统设置中开启。", style = MaterialTheme.typography.bodyMedium)
    TextButton(onClick = openSystemSettings) { Text("打开系统设置") }
  }
}

@Composable internal fun CapturePreferencesScreen(state: MainUiState, permissions: PermissionSnapshot, setAutoVideo: (Boolean) -> Unit) {
  PageColumn {
    Text("自动短视频", style = MaterialTheme.typography.headlineSmall)
    Text("检测到关键线索时，允许主机请求录制 6 秒视频。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
      Text(if (state.capturePreferences.autoVideoEnabled) "已开启" else "已关闭", Modifier.weight(1f))
      Switch(state.capturePreferences.autoVideoEnabled, setAutoVideo, enabled = state.session != null && permissions.camera)
    }
    Text("每小时最多 ${state.capturePreferences.autoVideoMaxPerHour} 段，每天最多 ${state.capturePreferences.autoVideoMaxPerDay} 段。录制仍受冷却时间和处理队列限制。")
    Text("关闭后仍可在感知页手动录制。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (state.session == null || !permissions.camera) Notice("需要设备连接与相机权限")
  }
}

@Composable internal fun DiagnosticsScreen(state: MainUiState, permissions: PermissionSnapshot, warning: HostWarning?, latestMessage: String, copy: (String) -> Unit) {
  PageColumn {
    SectionTitle("运行概况")
    DetailRow("感知", serviceLabel(state))
    DetailRow("最近音频上传", formatTimestampOrPlaceholder(state.serviceActivity.lastAudioUploadAt))
    DetailRow("最近图片上传", formatTimestampOrPlaceholder(state.serviceActivity.lastImageUploadAt))
    DetailRow("视频片段状态", formatVideoStatus(state.serviceActivity))
    DetailRow("后台分析队列", formatAnalysisQueueStatus(state.serviceActivity))
    DetailRow("待补传", "${state.serviceActivity.pendingUploads} 条")
    HorizontalDivider()
    SectionTitle("最近错误与事件")
    SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      DetailRow("最近错误", formatRecentError(state.serviceActivity))
      state.runtimeStatus.lastError?.let { DetailRow("服务错误", it) }
      state.assistant.lastError?.let { DetailRow("助手错误", it) }
      DetailRow("最近事件", latestMessage.ifBlank { "暂无" })
    } }
    OutlinedButton(onClick = { copy(buildRecentActivityDiagnostics(state, permissions, warning) + "\nlatestEvent=$latestMessage") }, modifier = Modifier.fillMaxWidth()) { Text("复制诊断信息") }
    Text("诊断包含设备地址及最近问答，请确认接收方后分享。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
