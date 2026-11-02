package ai.openclaw.clawsense.ui.screens

import ai.openclaw.clawsense.digital.*
import ai.openclaw.clawsense.ui.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

@Composable internal fun PersonChoice(state: DigitalUiState, project: String, selected: String?, enabled: Boolean, onSelect: (String?) -> Unit) {
  var expanded by remember { mutableStateOf(false) }
  val people = state.records("people").filter { it["projectIds"]?.jsonArray?.any { id -> id.jsonPrimitive.content == project } == true }
  val name = people.find { it.string("personId") == selected }?.string("displayName") ?: if (selected == null) "暂不关联人物" else "已关联人物"
  Box {
    OutlinedButton(onClick = { expanded = true }, enabled = enabled) { Text("对应人物：$name") }
    DropdownMenu(expanded, { expanded = false }) {
      DropdownMenuItem(text = { Text("暂不关联人物") }, onClick = { onSelect(null); expanded = false })
      people.forEach { person -> DropdownMenuItem(text = { Text("${person.string("displayName")} · ${person.string("personId").takeLast(8)}") }, onClick = { onSelect(person.string("personId")); expanded = false }) }
    }
  }
}

@Composable internal fun DraftScreen(state: DigitalUiState, vm: DigitalViewModel, connect: () -> Unit) {
  val item = state.draft
  if (item == null) { PageColumn { Text(if (state.loaded) "此条目已不可用" else "正在读取…") }; return }
  var advanced by rememberSaveable(item.id) { mutableStateOf(false) }
  var showDelete by rememberSaveable(item.id) { mutableStateOf(false) }
  var newPerson by rememberSaveable(item.id) { mutableStateOf("") }
  var personDialog by rememberSaveable(item.id) { mutableStateOf(false) }
  var editImage by rememberSaveable(item.id) { mutableStateOf(false) }
  val editable = item.status == "draft" && !state.busy
  val validTitle = item.title.isNotBlank() && item.title.length <= 300
  val validProject = item.projectId.isNotBlank() && item.projectId.length <= 200
  val validText = item.text.length <= 64_000
  val valid = validTitle && validProject && validText
  PageColumn {
    Text(inboxStatus(item.status), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    state.error?.let { Notice("操作未完成", it, error = true) }
    item.error?.let { Notice("同步未完成", it, error = true) }
    if (item.sourceType == "shared_image") DraftImage(item.id, vm.imageFile(item.id))
    OutlinedTextField(item.title, { vm.updateDraft(item.copy(title = it)) }, label = { Text("标题") }, enabled = editable, isError = !validTitle, supportingText = if (!validTitle) ({ Text("请填写 1–300 字的标题") }) else null, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(item.text, { vm.updateDraft(item.copy(text = it)) }, label = { Text(if (item.textOrigin == "device-ocr") "识别文字，请核对" else "内容") }, enabled = editable, isError = !validText, supportingText = if (!validText) ({ Text("内容最多 64,000 字") }) else null, minLines = 4, maxLines = 12, modifier = Modifier.fillMaxWidth())
    if (item.sourceType == "shared_image" && item.status == "draft") {
      OutlinedButton(onClick = { editImage = true }, enabled = editable && valid) { Text("裁剪或遮住敏感区域") }
      OutlinedButton(onClick = vm::recognize, enabled = editable && valid) { Text("在本机识别图片文字") }
    }
    OutlinedTextField(item.projectId, { vm.updateDraft(item.copy(projectId = it, personId = null)) }, label = { Text("项目") }, enabled = editable, isError = !validProject, supportingText = if (!validProject) ({ Text("请填写 1–200 字的项目名称或编号") }) else null, modifier = Modifier.fillMaxWidth())
    PersonChoice(state, item.projectId, item.personId, editable) { vm.updateDraft(item.copy(personId = it)) }
    if (editable && state.session != null) TextButton(onClick = { personDialog = true }) { Text("创建新人物") }
    TextButton(onClick = { advanced = !advanced }) { Text(if (advanced) "收起更多信息" else "更多信息（可选）") }
    androidx.compose.animation.AnimatedVisibility(advanced) {
      Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        OutlinedTextField(item.sessionId.orEmpty(), { vm.updateDraft(item.copy(sessionId = it.ifBlank { null })) }, label = { Text("关联面谈编号") }, enabled = editable, modifier = Modifier.fillMaxWidth())
        var selectEncounter by remember { mutableStateOf(false) }
        Box {
          TextButton(onClick = { selectEncounter = true }, enabled = editable) { Text("从本项目面谈中选择") }
          DropdownMenu(selectEncounter, { selectEncounter = false }) {
            DropdownMenuItem(text = { Text("不关联面谈") }, onClick = { vm.updateDraft(item.copy(sessionId = null)); selectEncounter = false })
            state.records("sessions").filter { it.string("projectId") == item.projectId }.forEach { encounter ->
              DropdownMenuItem(text = { Text(encounter.string("title")) }, onClick = { vm.updateDraft(item.copy(sessionId = encounter.string("sessionId"))); selectEncounter = false })
            }
          }
        }
        OutlinedTextField(item.claimedApp.orEmpty(), { vm.updateDraft(item.copy(claimedApp = it.ifBlank { null })) }, label = { Text("来源 App 备注") }, enabled = editable, modifier = Modifier.fillMaxWidth())
        Text("来源 App 是你的备注；截图只代表可见片段，分享时间不等于对话发生时间。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    if (item.status == "draft") {
      OutlinedButton(onClick = { vm.saveDraft() }, enabled = editable && valid, modifier = Modifier.fillMaxWidth()) { Text("保存到本机") }
      if (state.session == null) Notice("连接后才能同步", "草稿会保留在本机。", "连接数字记忆", onAction = connect)
      Button(onClick = vm::confirmSync, enabled = editable && valid && state.session != null, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("确认同步") }
    }
    if (item.status == "failed") Button(onClick = { vm.retry(item.id) }, enabled = !state.busy) { Text("重试同步") }
    if (item.status == "uploaded" && item.contact != null && item.personId != null) {
      val person = state.records("people").find { it.string("personId") == item.personId }
      if (person != null) {
        Notice("确认联系人身份", "仅关联你选择的通讯录联系人，不代表已确认其在其他 App 中的身份。")
        OutlinedButton(onClick = { vm.linkContact(item, person, false) }, enabled = !state.busy) { Text("确认通讯录身份关联") }
        TextButton(onClick = { vm.linkContact(item, person, true) }, enabled = !state.busy) { Text("撤回通讯录身份关联") }
      }
    }
    HorizontalDivider()
    TextButton(onClick = { showDelete = true }, enabled = !state.busy, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("删除内容") }
  }
  if (showDelete) AlertDialog(onDismissRequest = { showDelete = false }, title = { Text("删除这条内容？") }, text = { Text(if (item.eventId == null) "将删除本机内容，此操作无法撤销。" else "将同时删除电脑上的已同步内容，主机确认后再删除本机副本。") }, confirmButton = { TextButton(onClick = { showDelete = false; vm.delete(item) }) { Text("删除") } }, dismissButton = { TextButton(onClick = { showDelete = false }) { Text("取消") } })
  if (personDialog) AlertDialog(onDismissRequest = { personDialog = false }, title = { Text("创建新人物") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    OutlinedTextField(newPerson, { newPerson = it }, label = { Text("人物名称") })
    Text("将在当前项目中创建独立人物，同名人物不会自动合并。")
  } }, confirmButton = { TextButton(onClick = { vm.createPerson(newPerson); personDialog = false; newPerson = "" }, enabled = newPerson.isNotBlank() && validProject && !state.busy) { Text("确认创建") } }, dismissButton = { TextButton(onClick = { personDialog = false }) { Text("取消") } })
  if (editImage) {
    var left by remember { mutableFloatStateOf(0f) }; var top by remember { mutableFloatStateOf(0f) }; var right by remember { mutableFloatStateOf(1f) }; var bottom by remember { mutableFloatStateOf(1f) }; var mask by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { editImage = false }, title = { Text("在本机选择区域") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) {
      DraftImage(item.id, vm.imageFile(item.id))
      Text("裁剪保留区域；遮挡会涂黑该区域。完成后请预览新图，再重新识别文字。")
      Text("左边界 ${(left*100).toInt()}%"); Slider(left, { left = it }, valueRange = 0f..0.99f)
      Text("右边界 ${(right*100).toInt()}%"); Slider(right, { right = it }, valueRange = 0.01f..1f)
      Text("上边界 ${(top*100).toInt()}%"); Slider(top, { top = it }, valueRange = 0f..0.99f)
      Text("下边界 ${(bottom*100).toInt()}%"); Slider(bottom, { bottom = it }, valueRange = 0.01f..1f)
      Row { Checkbox(mask, { mask = it }); Text("遮挡所选区域") }
    } }, confirmButton = { TextButton(onClick = { vm.editImage(left, top, right, bottom, mask); editImage = false }, enabled = !state.busy && right > left && bottom > top) { Text("确认修改") } }, dismissButton = { TextButton(onClick = { editImage = false }) { Text("取消") } })
  }
}

@Composable internal fun MemoryDetailScreen(event: JsonObject?, state: DigitalUiState, vm: DigitalViewModel) {
  if (event == null) { PageColumn { Text("此记忆已不在当前缓存中，请返回后同步与刷新。") }; return }
  var editing by rememberSaveable(event.string("eventId")) { mutableStateOf(false) }
  var handledCorrection by rememberSaveable(event.string("eventId")) { mutableLongStateOf(state.correctionVersion) }
  LaunchedEffect(state.correctionVersion) {
    if (state.correctionVersion > handledCorrection) { editing = false; handledCorrection = state.correctionVersion }
  }
  var text by rememberSaveable(event.string("eventId")) { mutableStateOf(event.string("text")) }
  var person by rememberSaveable(event.string("eventId")) { mutableStateOf(event["personId"]?.jsonPrimitive?.contentOrNull) }
  var confirming by rememberSaveable(event.string("eventId")) { mutableStateOf(false) }
  var selectedEncounter by rememberSaveable(event.string("eventId")) { mutableStateOf("") }
  var selectedObject by rememberSaveable(event.string("eventId")) { mutableStateOf("") }
  val encounters = state.records("sessions").filter { it["projectId"] == event["projectId"] }
  PageColumn {
    Text(event.string("title"), style = MaterialTheme.typography.headlineSmall)
    SelectionContainer { Text(event.string("text"), style = MaterialTheme.typography.bodyLarge) }
    HorizontalDivider()
    DetailRow("项目", event.string("projectId"))
    DetailRow("来源", if (event.string("sourceType") == "shared_image") "截图可见片段" else "用户选择片段")
    DetailRow("版本", event.string("revision"))
    val digitalPerson = state.records("people").find { it["personId"] == event["personId"] }
    if (digitalPerson != null) {
      var choosePerson by remember { mutableStateOf(false) }
      Box { TextButton(onClick = { choosePerson = true }, enabled = !state.busy) { Text("关联已认识的现场人物") }
        DropdownMenu(choosePerson, { choosePerson = false }) {
          state.records("commonPeople").filter { target -> target["personId"] != digitalPerson["canonicalPersonId"] && target["projectIds"]?.jsonArray.orEmpty().contains(event["projectId"]) }.forEach { target -> DropdownMenuItem(text = { Text(target.string("displayName") + " · " + target.string("personId").takeLast(8)) }, onClick = { choosePerson = false; vm.linkCommonPerson(event, digitalPerson, target) }) }
        }
      }
      Text("请选择你确认是同一人的记录；不会因为名字相同而自动合并。")
      state.records("commonPeople").forEach { target -> target["links"]?.jsonArray.orEmpty().forEach { item -> val link = item.jsonObject
        if (link.string("state") == "confirmed" && (link["personId"] == digitalPerson["canonicalPersonId"] || link["otherPersonId"] == digitalPerson["canonicalPersonId"])) TextButton(onClick = { vm.withdrawCommonPerson(target, link.string("linkId")) }, enabled = !state.busy) { Text("撤回人物关联 · ${link.string("linkId").takeLast(8)}") }
      } }
    }
    state.error?.let { Notice("操作未完成", it, error = true) }
    OutlinedButton(onClick = { text = event.string("text"); person = event["personId"]?.jsonPrimitive?.contentOrNull; editing = true }, enabled = !state.busy) { Text("纠正文字或人物") }
    OutlinedButton(onClick = { text = event.string("text"); confirming = true }, enabled = !state.busy && encounters.isNotEmpty()) { Text("确认当前约定") }
    if (encounters.isEmpty()) Text("此项目还没有面谈。开启对应项目的交流或先在工作台建立面谈，再确认约定。")
  }
  if (editing) AlertDialog(onDismissRequest = { if (!state.busy) editing = false }, title = { Text("纠正记忆") }, text = {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      OutlinedTextField(text, { text = it }, label = { Text("确认后的文字") }, enabled = !state.busy, minLines = 3, maxLines = 8)
      PersonChoice(state, event.string("projectId"), person, !state.busy) { person = it }
      Text("原始图片保留，基于旧版本生成的工作会标记为过期。", style = MaterialTheme.typography.bodyMedium)
      state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
  }, confirmButton = { TextButton(onClick = { vm.correct(event, text, person) }, enabled = !state.busy && text.length <= 64_000) { Text("确认纠正") } }, dismissButton = { TextButton(onClick = { editing = false }, enabled = !state.busy) { Text("取消") } })
  if (confirming) {
    val encounter = encounters.find { it.string("sessionId") == selectedEncounter }
    AlertDialog(onDismissRequest = { confirming = false }, title = { Text("本人确认当前约定") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text("请核对人物、收到动作和期限。确认将保留这条分享作为来源，供下次交流和所选 Agent 使用。")
      OutlinedTextField(text, { text = it }, label = { Text("当前约定的完整内容") }, minLines = 3)
      encounters.forEach { item -> FilterChip(selected = selectedEncounter == item.string("sessionId"), onClick = { selectedEncounter = item.string("sessionId"); selectedObject = "" }, label = { Text(item.string("title")) }) }
      Text("选择要取代的约定；不选择则保存为独立约定。")
      encounter?.get("facts")?.jsonArray.orEmpty().forEach { fact -> val value = fact.jsonObject; FilterChip(selected = selectedObject == value.string("objectId"), onClick = { selectedObject = if (selectedObject == value.string("objectId")) "" else value.string("objectId") }, label = { Text(value.string("text").take(80)) }) }
    } }, confirmButton = { TextButton(onClick = { if (encounter != null) { vm.confirmFact(event, encounter, text, selectedObject.ifBlank { null }); confirming = false } }, enabled = !state.busy && encounter != null && text.isNotBlank() && text.length <= 16000) { Text("本人确认") } }, dismissButton = { TextButton(onClick = { confirming = false }) { Text("取消") } })
  }
}

@Composable private fun DraftImage(id: String, file: File) {
  val preview by produceState<ImageBitmap?>(null, id) {
    value = withContext(Dispatchers.IO) {
      runCatching { BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = 4 })?.asImageBitmap() }.getOrNull()
    }
  }
  preview?.let { Image(it, contentDescription = "分享图片预览", modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp), contentScale = ContentScale.Fit) }
}
