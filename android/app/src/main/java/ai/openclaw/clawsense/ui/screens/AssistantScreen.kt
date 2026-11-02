package ai.openclaw.clawsense.ui.screens

import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.*
import ai.openclaw.clawsense.ui.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

internal enum class AssistantGate { CONNECT, HOST, PERMISSION, START, RESTART, BUSY, READY }
internal fun assistantGate(state: MainUiState, permissions: PermissionSnapshot, hostBlocked: Boolean): AssistantGate = when {
  state.session == null -> AssistantGate.CONNECT
  hostBlocked -> AssistantGate.HOST
  !permissions.microphone || !permissions.notifications -> AssistantGate.PERMISSION
  state.runtimeStatus.phase in listOf(ServicePhase.STARTING, ServicePhase.STOPPING) -> AssistantGate.BUSY
  state.runtimeStatus.phase != ServicePhase.RUNNING -> AssistantGate.START
  state.runtimeStatus.mode !in listOf(CaptureMode.FULL, CaptureMode.AUDIO_ONLY) -> AssistantGate.RESTART
  state.assistant.phase in listOf(AssistantInteractionPhase.RECORDING_QUERY, AssistantInteractionPhase.WAITING_ANSWER, AssistantInteractionPhase.SPEAKING_ANSWER) -> AssistantGate.BUSY
  else -> AssistantGate.READY
}

@Composable internal fun AssistantScreen(
  state: MainUiState, permissions: PermissionSnapshot, hostBlocked: Boolean,
  open: (AppDestination) -> Unit, onStart: () -> Unit, onQuery: (AssistantModeHint) -> Unit, onStopSpeaking: () -> Unit, onOpenSensing: () -> Unit = {},
) {
  var mode by rememberSaveable { mutableStateOf(AssistantModeHint.AUTO) }
  val snapshot = state.assistant
  val gate = assistantGate(state, permissions, hostBlocked)
  val speaking = snapshot.phase == AssistantInteractionPhase.SPEAKING_ANSWER
  val phaseLabel = when (snapshot.phase) {
    AssistantInteractionPhase.RECORDING_QUERY -> "正在听你说"
    AssistantInteractionPhase.WAITING_ANSWER -> "正在思考"
    AssistantInteractionPhase.SPEAKING_ANSWER -> "正在朗读回答"
    AssistantInteractionPhase.ERROR_RECOVERY -> "上次提问未完成"
    else -> if (gate == AssistantGate.READY) "可以开始提问" else "准备你的实时助手"
  }
  Column(Modifier.fillMaxSize().testTag("screen_assistant")) {
    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
      TextButton(onClick = { open(AppDestination.LIVE) }) { Text("进入 Live 搭子（实验版）") }
      Text(phaseLabel, style = MaterialTheme.typography.headlineSmall)
      if (gate in listOf(AssistantGate.READY, AssistantGate.BUSY)) {
        Text(when (snapshot.phase) {
          AssistantInteractionPhase.RECORDING_QUERY -> "请说一句短问题，停顿后自动发送。"
          AssistantInteractionPhase.WAITING_ANSWER -> "正在结合最近记录生成回答。"
          AssistantInteractionPhase.SPEAKING_ANSWER -> "你可以随时停止朗读，回答文字会保留。"
          else -> "点击下方按钮，再说出你的问题。"
        }, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      @OptIn(ExperimentalLayoutApi::class)
      FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(AssistantModeHint.AUTO to "自动", AssistantModeHint.MEETING to "会议", AssistantModeHint.DESK to "工位").forEach { (value, label) ->
          FilterChip(selected = mode == value, onClick = { mode = value }, label = { Text(label) }, enabled = gate != AssistantGate.BUSY)
        }
      }
      when (gate) {
        AssistantGate.CONNECT -> Notice("先连接感知设备", "连接后，可以根据身边的声音和画面提问。")
        AssistantGate.HOST -> Notice("需要更新设备连接", "当前主机地址不可访问。", error = true)
        AssistantGate.PERMISSION -> Notice("需要麦克风与通知权限", "麦克风用于语音提问，通知用于保持感知服务运行。")
        AssistantGate.START -> Notice("感知尚未开启", "开启后即可提问，也会按现有设置采集环境声音和图片。")
        AssistantGate.RESTART -> Notice("麦克风尚未参与感知", "请到感知页停止后重新开启，以应用新授予的麦克风权限。")
        else -> Unit
      }
      if (!snapshot.queryText.isNullOrBlank()) {
        SectionTitle("最近提问")
        SelectionContainer { Text(snapshot.queryText, style = MaterialTheme.typography.bodyLarge) }
      }
      if (!snapshot.answerText.isNullOrBlank()) {
        HorizontalDivider()
        SectionTitle("最近回答")
        val spoken = snapshot.answerSpokenText?.trim().orEmpty()
        val body = snapshot.answerText.trim().removePrefix("上一轮完整回答如下：").trim()
        if (spoken.isNotBlank() && spoken != body) {
          Text(
            "语音先读简答；说“读全文”可听完整回答。",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
        SelectionContainer { Text(snapshot.answerText, style = MaterialTheme.typography.bodyLarge) }
      } else if (gate == AssistantGate.READY) {
        EmptyState(Icons.Outlined.ChatBubbleOutline, "想了解刚才发生了什么？", "试着问：“刚才讨论了哪些重点？”")
      }
      snapshot.lastError?.let { Notice("提问未完成", it, error = true) }
    }
    Surface(tonalElevation = 1.dp) {
      Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val label = if (speaking) "停止朗读" else when (gate) {
          AssistantGate.CONNECT -> "连接感知设备"
          AssistantGate.HOST -> "修复设备连接"
          AssistantGate.PERMISSION -> "前往授权"
          AssistantGate.START -> "开启感知"
          AssistantGate.RESTART -> "前往感知重启"
          AssistantGate.BUSY -> if (state.runtimeStatus.phase == ServicePhase.STOPPING) "正在结束…" else if (state.runtimeStatus.phase == ServicePhase.STARTING) "正在开启…" else if (snapshot.phase == AssistantInteractionPhase.RECORDING_QUERY) "正在听你说…" else "正在思考…"
          AssistantGate.READY -> "问实时助手"
        }
        Button(onClick = {
          if (speaking) onStopSpeaking() else when (gate) {
            AssistantGate.CONNECT, AssistantGate.HOST -> open(AppDestination.SENSOR_CONNECTION)
            AssistantGate.PERMISSION -> open(AppDestination.PERMISSIONS)
            AssistantGate.START -> onStart()
            AssistantGate.RESTART -> onOpenSensing()
            AssistantGate.READY -> onQuery(mode)
            AssistantGate.BUSY -> Unit
          }
        }, enabled = speaking || gate != AssistantGate.BUSY, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("assistant_primary")) {
          Icon(if (speaking) Icons.Outlined.StopCircle else when (gate) {
            AssistantGate.CONNECT, AssistantGate.HOST -> Icons.Outlined.Link
            AssistantGate.PERMISSION -> Icons.Outlined.Security
            AssistantGate.START -> Icons.Outlined.PlayArrow
            AssistantGate.RESTART -> Icons.Outlined.Refresh
            else -> Icons.Outlined.Mic
          }, contentDescription = null)
          Spacer(Modifier.width(10.dp)); Text(label)
        }
      }
    }
  }
}
