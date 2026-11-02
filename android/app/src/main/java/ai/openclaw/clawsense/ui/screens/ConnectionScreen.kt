package ai.openclaw.clawsense.ui.screens

import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.DeviceSession
import ai.openclaw.clawsense.ui.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable internal fun SensorConnectionScreen(state: MainUiState, warning: HostWarning?, onName: (String) -> Unit, onCode: (String) -> Unit, onHost: (String) -> Unit, onToken: (String) -> Unit, scanner: () -> Unit, pairCode: () -> Unit, pairManual: () -> Unit, clear: () -> Unit) {
  var manual by rememberSaveable { mutableStateOf(false) }
  var details by rememberSaveable { mutableStateOf(false) }
  var submitted by rememberSaveable { mutableStateOf(false) }
  var confirmClear by rememberSaveable { mutableStateOf(false) }
  PageColumn {
    Text(if (state.session == null) "连接你的感知设备" else "已连接感知主机", style = MaterialTheme.typography.headlineSmall)
    Text("用于环境采集和实时助手。使用电脑生成的感知设备配对码。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    state.session?.let { Text(it.host) }
    warning?.let { Notice(it.title, it.detail, error = it.blocksStart) }
    if (state.isBusy) LinearProgressIndicator(Modifier.fillMaxWidth())
    state.pairingError?.let { Notice("连接失败", it, error = true) }
    if (state.session == null) OutlinedTextField(state.deviceName, onName, label = { Text("设备名称") }, enabled = !state.isBusy, modifier = Modifier.fillMaxWidth())
    Button(onClick = scanner, enabled = !state.isBusy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("扫码连接") }
    OutlinedTextField(state.setupCode, onCode, label = { Text("或粘贴配对码") }, minLines = 2, maxLines = 4, enabled = !state.isBusy, isError = submitted && !manual && state.setupCode.isBlank(), supportingText = if (submitted && !manual && state.setupCode.isBlank()) ({ Text("请扫码或粘贴配对码") }) else null, modifier = Modifier.fillMaxWidth())
    OutlinedButton(onClick = { submitted = true; if (state.setupCode.isNotBlank()) pairCode() }, enabled = !state.isBusy, modifier = Modifier.fillMaxWidth()) { Text(if (state.session == null) "用配对码连接" else "更新设备连接") }
    TextButton(onClick = { manual = !manual; submitted = false }) { Text(if (manual) "收起手动连接" else "手动填写主机与令牌") }
    androidx.compose.animation.AnimatedVisibility(manual) {
      Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        OutlinedTextField(state.manualHost, onHost, label = { Text("主机地址") }, placeholder = { Text("http://192.168.1.100:18789") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true, enabled = !state.isBusy, isError = submitted && state.manualHost.isBlank(), supportingText = if (submitted && state.manualHost.isBlank()) ({ Text("请输入主机地址") }) else null, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(state.manualToken, onToken, label = { Text("配对令牌") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !state.isBusy, isError = submitted && state.manualToken.isBlank(), supportingText = if (submitted && state.manualToken.isBlank()) ({ Text("请输入配对令牌") }) else null, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { submitted = true; if (state.manualHost.isNotBlank() && state.manualToken.isNotBlank()) pairManual() }, enabled = !state.isBusy) { Text("手动连接") }
      }
    }
    state.session?.let { session ->
      HorizontalDivider()
      TextButton(onClick = { details = !details }) { Text(if (details) "收起设备信息" else "查看设备信息") }
      if (details) DeviceDetails(session, state.serviceEnabled)
      TextButton(onClick = { confirmClear = true }, enabled = !state.isBusy, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("清除感知配对") }
    }
  }
  if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("清除感知配对？") }, text = { Text("将停止感知并移除当前感知设备凭据及其待补传内容。数字记忆连接保持独立。") }, confirmButton = { TextButton(onClick = { confirmClear = false; clear() }) { Text("停止并清除") } }, dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("取消") } })
}

@Composable private fun DeviceDetails(session: DeviceSession, enabled: Boolean) {
  DetailRow("设备 ID", session.deviceId)
  DetailRow("上传地址", session.uploadBaseUrl)
  DetailRow("记忆空间", session.memoryNamespace)
  DetailRow("心跳间隔", "${session.heartbeatIntervalSec} 秒")
  DetailRow("感知自动恢复", if (enabled) "已开启" else "已关闭")
}

@Composable internal fun DigitalConnectionScreen(session: DeviceSession?, code: String, onCode: (String) -> Unit, busy: Boolean, error: String?, scanner: () -> Unit, pair: () -> Unit) {
  var submitted by rememberSaveable { mutableStateOf(false) }
  PageColumn {
    Text(if (session == null) "连接你的数字记忆" else "已连接数字记忆", style = MaterialTheme.typography.headlineSmall)
    Text("在电脑控制台选择“主手机”，生成专用配对码。这份连接用于同步分享内容，与感知设备连接分别保存。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    session?.let { Text(it.host) }
    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    error?.let { Notice("连接未完成", it, error = true) }
    Button(onClick = scanner, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("扫码连接数字记忆") }
    OutlinedTextField(code, onCode, label = { Text("或粘贴主手机配对码") }, minLines = 2, maxLines = 5, enabled = !busy, isError = submitted && code.isBlank(), supportingText = if (submitted && code.isBlank()) ({ Text("请扫码或粘贴主手机配对码") }) else null, modifier = Modifier.fillMaxWidth())
    OutlinedButton(onClick = { submitted = true; if (code.isNotBlank()) pair() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (session == null) "连接数字记忆" else "更新数字记忆连接") }
  }
}
