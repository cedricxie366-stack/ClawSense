package ai.openclaw.clawsense.ui.screens

import ai.openclaw.clawsense.digital.*
import ai.openclaw.clawsense.ui.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private fun memoryTimestamp(value: Long) = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(value))
internal fun inboxStatus(status: String) = when (status) { "draft" -> "仅在本机"; "queued" -> "等待同步"; "uploaded" -> "已保存到电脑"; else -> "同步失败" }
internal fun JsonObject.string(key: String): String = get(key)?.jsonPrimitive?.contentOrNull.orEmpty()
internal fun DigitalUiState.records(key: String): List<JsonObject> = cache?.get(key)?.jsonArray.orEmpty().map { it.jsonObject }

@Composable internal fun MemoryScreen(state: DigitalUiState, addImages: () -> Unit, addContact: () -> Unit, addNote: () -> Unit, sync: () -> Unit, openDraft: (String) -> Unit, openMemory: (String) -> Unit, connect: () -> Unit, confirmMemory: ((JsonObject, JsonObject, String) -> Unit)? = null) {
  var section by rememberSaveable { mutableIntStateOf(0) }
  var query by rememberSaveable { mutableStateOf("") }
  var showAdd by rememberSaveable { mutableStateOf(false) }
  var selectedMemory by remember { mutableStateOf<JsonObject?>(null) }
  var review by rememberSaveable { mutableStateOf(false) }
  Column(Modifier.fillMaxSize().testTag("screen_memory")) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
      Box {
        FilledTonalButton(onClick = { showAdd = true }, enabled = !state.busy) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text("添加") }
        DropdownMenu(showAdd, { showAdd = false }) {
          DropdownMenuItem(text = { Text("选择截图") }, onClick = { showAdd = false; addImages() })
          DropdownMenuItem(text = { Text("选择联系人") }, onClick = { showAdd = false; addContact() })
          DropdownMenuItem(text = { Text("新建笔记") }, onClick = { showAdd = false; section = 0; addNote() })
        }
      }
      TextButton(onClick = sync, enabled = !state.busy && state.session != null) { Text("同步与刷新") }
    }
    TabRow(selectedTabIndex = section) {
      listOf("收件箱", "已同步", "共同背景").forEachIndexed { index, label -> Tab(section == index, { section = index }, text = { Text(label) }) }
    }
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (section > 0) OutlinedTextField(query, { query = it }, label = { Text("关键词、项目或人物") }, singleLine = true, leadingIcon = { Icon(Icons.Outlined.Search, null) }, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp))
    val people = state.records("people")
    val events = state.records("events").filter { event -> query.isBlank() || (event.toString() + people.find { it["personId"] == event["personId"] }?.string("displayName").orEmpty()).contains(query, true) }
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      if (state.session == null) item { Notice("数字记忆尚未连接", "可以先保存到本机，连接后再确认同步。", "连接数字记忆", onAction = connect) }
      state.error?.let { error -> item { Notice("操作未完成", error, error = true) } }
      if (section == 0) {
        item { Text("分享内容先留在本机，确认后才同步。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (state.loaded && state.items.isEmpty()) item { EmptyState(Icons.Outlined.Inbox, "收件箱还是空的", "添加截图、笔记，或从其他 App 分享内容。") }
        items(state.items, key = { it.id }) { item ->
          ListItem(headlineContent = { Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis) }, supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
              Text("${inboxStatus(item.status)} · ${memoryTimestamp(item.capturedAt)}")
              if (item.text.isNotBlank()) Text(item.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
              item.error?.let { Text(it, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
          }, leadingContent = { Icon(when(item.sourceType) { "shared_image" -> Icons.Outlined.Image; "contact_selection" -> Icons.Outlined.PersonOutline; else -> Icons.Outlined.Notes }, null) }, modifier = Modifier.clickable(enabled = !state.busy) { openDraft(item.id) }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface))
          HorizontalDivider()
        }
      } else if (section == 1) {
        item { Text("显示最近一次同步的内容；同步与刷新可获取更新。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (events.isEmpty()) item { EmptyState(Icons.Outlined.Search, if (query.isBlank()) "还没有已同步记忆" else "没有找到匹配内容", "只会显示你已确认分享的片段。") }
        items(events, key = { it.string("eventId") }) { event ->
          ListItem(headlineContent = { Text(event.string("title"), maxLines = 2, overflow = TextOverflow.Ellipsis) }, supportingContent = { Text(event.string("text"), maxLines = 3, overflow = TextOverflow.Ellipsis) }, modifier = Modifier.clickable(enabled = !state.busy) { openMemory(event.string("eventId")) }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface))
          HorizontalDivider()
        }
      } else {
        val savedAt = state.cache?.get("cacheSavedAt")?.jsonPrimitive?.longOrNull ?: 0L
        item { Text("上次验证：${memoryTimestamp(savedAt)}。离线只读该次获准副本，无法确认后来撤销；24小时到期后隐藏。", style = MaterialTheme.typography.bodyMedium) }
        val memories = state.cache?.get("memory")?.jsonObject?.get("entries")?.jsonArray.orEmpty().map { it.jsonObject }.filter { query.isBlank() || it.toString().contains(query, true) }
        item { TextButton(onClick = { review = !review }) { Text(if (review) "收起回顾" else "回顾当前获准的背景") } }
        if (review) item {
          val facts = memories.filter { it.string("state") == "confirmed" }
          val results = memories.filter { it.string("state") == "accepted-current" }
          val unresolved = memories.filter { it.string("state") == "unconfirmed" }
          Text("本机规则回顾 · ${memories.size}条获准缓存，最多100条；不代表完整经历。", style = MaterialTheme.typography.titleSmall)
          androidx.compose.foundation.text.selection.SelectionContainer { Text("本人确认：\n" + facts.take(10).joinToString("\n") { it.string("text") } + "\n\n已接受成果：\n" + results.take(5).joinToString("\n") { it.string("text").take(500) } + "\n\n尚待确认：${unresolved.size}条。原话、模型分析和确认分别保留；未确认片段不成为约定。") }
        }
        if (memories.isEmpty()) item { EmptyState(Icons.Outlined.History, "没有获准的共同背景", "刷新可获取现场原话、纠正和已接受成果。") }
        items(memories, key = { it["ref"].toString() }) { memory ->
          ListItem(headlineContent = { Text(if (memory.string("state") == "accepted-current") "已接受的成果" else if (memory.string("state") == "confirmed") "本人确认的约定" else "来源记录 · 未确认") }, supportingContent = { androidx.compose.foundation.text.selection.SelectionContainer { Text(memory.string("text")) } })
          if (confirmMemory != null && memory.string("state") != "accepted-current") TextButton(onClick = { selectedMemory = memory }, enabled = !state.busy) { Text("本人确认或纠正") }
          HorizontalDivider()
        }
      }
    }
  }
  selectedMemory?.let { memory ->
    var text by remember(memory) { mutableStateOf(memory.string("text")) }
    var encounterId by remember(memory) { mutableStateOf(memory.string("sessionId")) }
    val encounters = state.records("sessions").filter { memory["projectIds"]?.jsonArray.orEmpty().contains(it["projectId"]) }
    val encounter = encounters.find { it.string("sessionId") == encounterId }
    AlertDialog(onDismissRequest = { selectedMemory = null }, title = { Text("从来源确认当前事实") }, text = { Column {
      Text("核对这条来源后，再确认完整事实；模型分析不会自动获得确认权威。")
      OutlinedTextField(text, { text = it }, label = { Text("本人确认的内容") }, minLines = 3)
      encounters.forEach { row -> FilterChip(selected = encounterId == row.string("sessionId"), onClick = { encounterId = row.string("sessionId") }, label = { Text(row.string("title")) }) }
      if (encounters.isEmpty()) Text("请先为该项目建立面谈，再关联确认。")
    } }, confirmButton = { TextButton(onClick = { if (encounter != null) { confirmMemory?.invoke(memory, encounter, text); selectedMemory = null } }, enabled = !state.busy && encounter != null && text.isNotBlank() && text.length <= 16000) { Text("本人确认") } }, dismissButton = { TextButton(onClick = { selectedMemory = null }) { Text("取消") } })
  }
}
