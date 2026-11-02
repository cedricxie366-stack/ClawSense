package ai.openclaw.clawsense.ui

import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable

internal enum class AppTab(val label: String) { ASSISTANT("助手"), MEMORY("记忆"), SENSING("感知"), SETTINGS("设置") }
internal enum class AppDestination(val title: String) {
  LIVE("Live 搭子"), HOME(""), SENSOR_CONNECTION("感知设备连接"), DIGITAL_CONNECTION("数字记忆连接"),
  PERMISSIONS("权限"), CAPTURE_PREFERENCES("感知偏好"), DIAGNOSTICS("诊断与最近活动"),
  DRAFT("分享内容"), MEMORY_DETAIL("记忆详情"),
}
internal class AppNavigation(tab: AppTab = AppTab.ASSISTANT, destination: AppDestination = AppDestination.HOME, itemId: String = "") {
  var tab by mutableStateOf(tab); private set
  var destination by mutableStateOf(destination); private set
  var itemId by mutableStateOf(itemId); private set
  fun select(tab: AppTab) { this.tab = tab; destination = AppDestination.HOME; itemId = "" }
  fun open(destination: AppDestination, itemId: String = "") { this.destination = destination; this.itemId = itemId }
  fun back(): Boolean = when {
    destination != AppDestination.HOME -> { destination = AppDestination.HOME; itemId = ""; true }
    tab != AppTab.ASSISTANT -> { select(AppTab.ASSISTANT); true }
    else -> false
  }
  companion object {
    val Saver = listSaver<AppNavigation, String>(
      save = { listOf(it.tab.name, it.destination.name, it.itemId) },
      restore = { AppNavigation(AppTab.valueOf(it[0]), AppDestination.valueOf(it[1]), it[2]) },
    )
  }
}
@Composable internal fun rememberAppNavigation() = rememberSaveable(saver = AppNavigation.Saver) { AppNavigation() }
