package ai.openclaw.clawsense.live

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.service.SensorServiceController
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.serialization.json.*

@Composable internal fun LiveScreen() {
  val context = LocalContext.current
  val controller = remember { AppGraph.live(context) }
  val legacy by AppGraph.repository(context).assistantSnapshot.collectAsStateWithLifecycle()
  val legacyBusy = legacy.phase in listOf(ai.openclaw.clawsense.data.AssistantInteractionPhase.RECORDING_QUERY, ai.openclaw.clawsense.data.AssistantInteractionPhase.WAITING_ANSWER, ai.openclaw.clawsense.data.AssistantInteractionPhase.SPEAKING_ANSWER)
  val state by controller.state.collectAsStateWithLifecycle()
  val runtime by AppGraph.repository(context).runtimeStatus.collectAsStateWithLifecycle()
  val stopping = runtime.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPING
  val clipboard = LocalClipboardManager.current
  var input by remember { mutableStateOf("") }
  var correction by remember { mutableStateOf<String?>(null) }
  var correctionInputId by remember { mutableStateOf(0L) }
  var editor by remember { mutableStateOf("") }
  var native by remember { mutableStateOf(false) }
  var visual by remember { mutableStateOf(false) }
  var agent by remember { mutableStateOf("dsh") }
  var historyQuery by remember { mutableStateOf("") }
  val permissionRequest = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
    if (result[Manifest.permission.RECORD_AUDIO] == true && (!visual || result[Manifest.permission.CAMERA] == true)) SensorServiceController.startLive(context, native, visual)
  }
  LaunchedEffect(state.personaJson) { editor = state.personaJson }
  LaunchedEffect(state.connected) { if (!state.connected) correction = null }
  LaunchedEffect(state.inputReceipt.id, state.configuring, state.transcript.isBlank()) {
    correction = null
  }
  LaunchedEffect(Unit) { controller.prepare() }
  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
    Text("Live 搭子 · 实验版", style = MaterialTheme.typography.headlineSmall)
    if (ai.openclaw.clawsense.BuildConfig.DEBUG) TextButton(enabled = !state.connected && !state.connecting && !legacyBusy,
      onClick = { context.startActivity(android.content.Intent(context, UpstreamLiveActivity::class.java)) }) { Text("进入 Live 对照版") }
    Text("手机收音，电脑处理基础对话；开启后可连续交流。")
    val personaData = runCatching { Json.parseToJsonElement(state.personaJson).jsonObject }.getOrNull()
    val name = personaData?.get("name")?.jsonPrimitive?.contentOrNull ?: "小伴"
    if (personaData != null) {
      Row {
        Switch(personaData["publicScene"]?.jsonPrimitive?.booleanOrNull == true, { enabled -> controller.setPersona(JsonObject(personaData.toMutableMap().apply { put("publicScene", JsonPrimitive(enabled)) }).toString()) })
        Text("公开场景：只使用公共资料")
      }
      if (personaData["publicScene"]?.jsonPrimitive?.booleanOrNull != true) Text("本人模式可能朗读已授权的私密信息；与他人交流时请选择公开场景。")
      else Text("公开场景当前支持本地回答；宿主工作请在本人模式发起。")
    }
    Text(when {
      state.connecting && state.startupStage == "loading_models" -> "电脑正在加载语音能力…"
      state.connecting && state.startupStage == "warming_voice" -> "正在完成声音准备…"
      state.connecting -> "正在连接电脑…"
      state.connected && !state.inputReady -> "正在开启麦克风…"
      state.connected && state.speaking -> "正在说话，你可以打断"
      state.connected -> "正在听你说"
      state.backgroundPreparing -> "正在提前准备对话，尚未开启收音和拍照。"
      else -> "Live 未开启"
    })
    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    state.notice?.let { Text("提示：$it") }
    Row { Checkbox(native, { native = it }, enabled = !state.connected && !state.connecting); Text("优先原生语音（不可用时回退本地）") }
    Row { Checkbox(visual, { visual = it; if (it) controller.prepare(vision = true) }, enabled = !state.connected && !state.connecting); Text("启用当前镜头（仅提问时取新照片）") }
    Button(enabled = !stopping && (state.connected || state.connecting || (!legacyBusy && !state.configuring && personaData != null)), onClick = { if (state.connected || state.connecting) SensorServiceController.stopLive(context) else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED || (visual && ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)) permissionRequest.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS, *if (visual) arrayOf(Manifest.permission.CAMERA) else emptyArray())) else SensorServiceController.startLive(context, native, visual) }, modifier = Modifier.fillMaxWidth()) { Text(if (stopping) "正在结束…" else if (state.connected || state.connecting) "结束 Live" else if (state.configuring) "正在保存设置…" else "开启 Live") }
    Text(if (personaData?.get("participation")?.jsonPrimitive?.content == "addressed") "开启后看到聆听状态即可直接说，也可以叫“$name”；安静超过30秒后请再次点名。语音发起工作仍需先点名。" else "先叫“$name”，再连续追问；语音发起工作需先点名。")
    if (state.connected) {
      Text("当前由${liveRouteLabel(state.route)}处理")
      Text(if (state.echoAvailable) "设备回声消除已开启，实际效果待听验" else "设备未提供回声消除；建议使用耳机验证打断")
      TextButton(onClick = controller::interrupt) { Text("停止说话（宿主任务可能仍在运行）") }
      OutlinedTextField(input, { input = it }, label = { Text("也可以输入文字") }, modifier = Modifier.fillMaxWidth())
      Row { FilterChip(selected = agent == "dsh", onClick = { agent = "dsh" }, label = { Text("DSH 工作") }); FilterChip(selected = agent == "codex", onClick = { agent = "codex" }, label = { Text("Codex 工作") }) }
      Button(onClick = { controller.text(input, agent = agent); input = "" }, enabled = input.isNotBlank() && !state.configuring) { Text("发送") }
    }
    if (state.transcript.isNotBlank()) {
      Text("识别文字（未确认）", style = MaterialTheme.typography.titleMedium)
      SelectionContainer { Text(state.transcript) }
      if (state.connected) TextButton(onClick = { correctionInputId = state.inputReceipt.id; correction = state.transcript }) { Text("修改识别后重新提问") }
    }
    liveInputStatusLabel(state.inputReceipt.status)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    if (state.inputReceipt.alternative.isNotBlank()) {
      Text("另一次识别结果不同，请核对；两种结果都可能有误。", style = MaterialTheme.typography.bodySmall)
      SelectionContainer { Text(state.inputReceipt.alternative) }
      if (state.connected) TextButton(onClick = { correctionInputId = state.inputReceipt.id; correction = state.inputReceipt.alternative }) { Text("编辑这份备选") }
    }
    correction?.takeIf { state.connected && state.transcript.isNotBlank() && !state.configuring && correctionInputId == state.inputReceipt.id }?.let { draft ->
      OutlinedTextField(draft, { correction = it }, label = { Text("修改后作为新问题发送") }, modifier = Modifier.fillMaxWidth())
      Text("只会重新提问，不会改写原识别记录，也不等于本人确认记忆。", style = MaterialTheme.typography.bodySmall)
      Row {
        Button(onClick = { controller.text(draft, agent = agent); correction = null }, enabled = draft.isNotBlank() && draft.length <= 4000 && state.connected && !state.configuring) { Text("重新提问") }
        TextButton(onClick = { correction = null }) { Text("取消") }
      }
    }
    if (state.answer.isNotBlank()) { Text("搭子的回答", style = MaterialTheme.typography.titleMedium); SelectionContainer { Text(state.answer) } }
    if (state.workResults.isNotBlank()) { HorizontalDivider(); Text("宿主工作与成果", style = MaterialTheme.typography.titleMedium); SelectionContainer { Text(state.workResults) } }
    val jobs = runCatching { Json.parseToJsonElement(state.workJson).jsonArray }.getOrNull().orEmpty()
    jobs.take(5).forEach { value -> val row = value.jsonObject; val id = row["workItemId"]!!.jsonPrimitive.content; val status = row["status"]!!.jsonPrimitive.content
      if (state.connected && status in listOf("queued", "running")) TextButton(onClick = { controller.cancelTask(id) }) { Text("取消这项工作 · ${id.takeLast(8)}") }
      if (state.connected && status == "interrupted" && row["failure"]?.jsonPrimitive?.content == "queued_requires_resume") TextButton(onClick = { controller.resumeTask(id) }) { Text("恢复未派发的工作 · ${id.takeLast(8)}") }
      val resultId = row["resultId"]?.jsonPrimitive?.contentOrNull
      val revision = row["reviewRevision"]?.jsonPrimitive?.intOrNull
      if (status == "completed" && row["stale"]?.jsonPrimitive?.booleanOrNull != true && resultId != null && revision != null) {
        Row { TextButton(onClick = { controller.reviewTask(resultId, revision, true) }) { Text("本人接受 · ${id.takeLast(8)}") }; TextButton(onClick = { controller.reviewTask(resultId, revision, false) }) { Text("拒绝这个稿件") } }
      }
    }
    TextButton(onClick = controller::refreshWork) { Text("刷新工作状态") }
    HorizontalDivider(); Text("近期会话", style = MaterialTheme.typography.titleMedium)
    OutlinedTextField(historyQuery, { historyQuery = it }, label = { Text("人物或关键词") }, modifier = Modifier.fillMaxWidth())
    TextButton(onClick = { controller.refreshHistory(historyQuery) }) { Text("查找获准会话") }
    if (state.historyText.isNotBlank()) SelectionContainer { Text(state.historyText) }
    if (state.personaJson.isNotBlank()) {
      HorizontalDivider(); Text("人格与声音", style = MaterialTheme.typography.titleMedium)
      if (!state.styleControl) Text("当前声音支持音色选择；细致情绪和语调需升级语音模型。")
      val presets = runCatching { Json.parseToJsonElement(state.presetsJson).jsonArray }.getOrNull().orEmpty()
      Row { presets.forEach { p -> TextButton(onClick = { editor = p.toString() }) { Text(p.jsonObject["name"]!!.jsonPrimitive.content) } } }
      Text("可编辑背景、表达、口癖、voice、style。participation 可选 quiet / addressed / active；主动模式需自行开启。")
      if (state.voices.isNotEmpty()) Text("可用音色：${state.voices.joinToString()}")
      val draft = runCatching { Json.parseToJsonElement(editor).jsonObject }.getOrNull()
      if (draft != null) {
        fun update(key: String, value: JsonElement) { editor = JsonObject(draft + (key to value)).toString() }
        OutlinedTextField(draft["name"]?.jsonPrimitive?.content.orEmpty(), { update("name", JsonPrimitive(it)) }, label = { Text("搭子的名字") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(draft["background"]?.jsonPrimitive?.content.orEmpty(), { update("background", JsonPrimitive(it)) }, label = { Text("角色背景与人生设定") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(draft["expression"]?.jsonPrimitive?.content.orEmpty(), { update("expression", JsonPrimitive(it)) }, label = { Text("表达习惯") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(draft["catchphrases"]?.jsonArray?.joinToString("，") { it.jsonPrimitive.content }.orEmpty(), { update("catchphrases", JsonArray(it.split('，', ',').map(String::trim).filter(String::isNotBlank).map(::JsonPrimitive))) }, label = { Text("偶尔使用的口癖，用逗号分隔") }, modifier = Modifier.fillMaxWidth())
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { state.voices.forEach { voice -> FilterChip(selected = draft["voice"]?.jsonPrimitive?.content?.lowercase() == voice.lowercase(), onClick = { update("voice", JsonPrimitive(voice)) }, label = { Text(voice) }) } }
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("quiet" to "安静", "addressed" to "点名回应", "active" to "主动参与").forEach { (value, label) -> FilterChip(selected = draft["participation"]?.jsonPrimitive?.content == value, onClick = { update("participation", JsonPrimitive(value)) }, label = { Text(label) }) } }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("当众交流，只用公共资料"); Switch(checked = draft["publicScene"]?.jsonPrimitive?.booleanOrNull == true, onCheckedChange = { update("publicScene", JsonPrimitive(it)) }) }
        if (state.styleControl) OutlinedTextField(draft["style"]?.jsonPrimitive?.content.orEmpty(), { update("style", JsonPrimitive(it)) }, label = { Text("语调与情绪") }, modifier = Modifier.fillMaxWidth())
      }
      Text("高级配置与导入导出", style = MaterialTheme.typography.titleSmall)
      OutlinedTextField(editor, { editor = it }, label = { Text("人格 JSON（可粘贴导入）") }, modifier = Modifier.fillMaxWidth(), minLines = 6)
      Row { Button(onClick = { controller.setPersona(editor) }, enabled = !state.connecting && !state.configuring) { Text("保存") }; TextButton(onClick = { clipboard.setText(AnnotatedString(editor)) }) { Text("复制导出") } }
    }
    if (state.inputDiagnosticsJson.isNotBlank()) TextButton(onClick = {
      clipboard.setText(AnnotatedString("phoneInputFrames=${controller.inputFrames.get()}\nhostInput=" + state.inputDiagnosticsJson))
    }) { Text("收音异常时复制诊断") }
  }
}
