package ai.openclaw.clawsense.digital

import ai.openclaw.clawsense.data.DeviceSession
import android.net.Uri
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*

internal data class DigitalUiState(
  val items: List<InboxItem> = emptyList(), val cache: JsonObject? = null, val session: DeviceSession? = null,
  val busy: Boolean = false, val loaded: Boolean = false, val error: String? = null, val draft: InboxItem? = null, val correctionVersion: Long = 0,
)
internal sealed interface DigitalEvent {
  data class Message(val text: String) : DigitalEvent
  data class OpenDraft(val id: String) : DigitalEvent
  data object CloseDetail : DigitalEvent
  data object Connected : DigitalEvent
}

internal class DigitalViewModel(private val repository: DigitalRepository, private val savedState: SavedStateHandle) : ViewModel() {
  private val restoredDraft = savedState.get<String>("draft")?.let { runCatching { Json.decodeFromString<InboxItem>(it) }.getOrNull() }
  private val state = MutableStateFlow(DigitalUiState(draft = restoredDraft, correctionVersion = savedState.get<Long>("correctionVersion") ?: 0))
  val uiState = state.asStateFlow()
  private val eventChannel = Channel<DigitalEvent>(Channel.BUFFERED)
  val events = eventChannel.receiveAsFlow()
  val dirty: Boolean get() = state.value.draft?.let { draft -> draft.status == "draft" && draft != state.value.items.find { it.id == draft.id } } == true

  init { reload(); viewModelScope.launch { while (true) { kotlinx.coroutines.delay(60_000); if (!state.value.busy) runCatching { refreshLocal() } } } }
  private suspend fun refreshLocal() {
    val items = withContext(Dispatchers.IO) { repository.inbox.list() }
    val cached = repository.cached()
    state.update { current ->
      val draft = current.draft?.let { if (it.status == "draft") it else items.find { updated -> updated.id == it.id } }
      current.copy(items = items, cache = cached, session = repository.session(), loaded = true, draft = draft)
    }
  }
  fun reload() {
    if (!state.value.busy) viewModelScope.launch {
      runCatching { refreshLocal() }.onFailure { error -> state.update { it.copy(error = error.message ?: "无法读取本机内容", loaded = true) } }
    }
  }
  private fun action(block: suspend () -> Unit) {
    if (state.value.busy) return
    state.update { it.copy(busy = true, error = null) }
    viewModelScope.launch {
      try { block(); refreshLocal() }
      catch (error: Exception) {
        val message = friendlyError(error)
        state.update { it.copy(error = message) }
        eventChannel.send(DigitalEvent.Message(message))
        runCatching { refreshLocal() }
      } finally { state.update { it.copy(busy = false) } }
    }
  }
  fun imageFile(id: String) = repository.inbox.imageFile(id)
  fun dismissError() { state.update { it.copy(error = null) } }
  fun pair(code: String) = action {
    repository.pair(code); eventChannel.send(DigitalEvent.Connected); eventChannel.send(DigitalEvent.Message("数字记忆已连接"))
  }
  fun createNote() = action { val item = repository.createText("", "补充笔记"); eventChannel.send(DigitalEvent.OpenDraft(item.id)) }
  fun addImages(uris: List<Uri>) {
    if (uris.isEmpty()) return
    action {
      val ids = uris.map { repository.createImage(it).id }
      if (ids.size == 1) eventChannel.send(DigitalEvent.OpenDraft(ids.single()))
      eventChannel.send(DigitalEvent.Message("已保存 ${ids.size} 张图片到本机，请检查后确认同步"))
    }
  }
  fun addContact(load: suspend () -> SelectedContact) = action {
    val item = repository.createContact(load()); eventChannel.send(DigitalEvent.OpenDraft(item.id))
  }
  fun sync() = action {
    val success = repository.sync(); repository.refresh()
    eventChannel.send(DigitalEvent.Message(if (success) "已刷新，详情见同步状态" else "暂时无法同步，内容已保留在本机"))
  }
  fun retry(id: String) = action { repository.queue(id); repository.sync(); eventChannel.send(DigitalEvent.Message("已重试，请查看同步状态")) }
  fun delete(item: InboxItem) = action {
    repository.delete(item)
    if (state.value.draft?.id == item.id) discardDraft()
    eventChannel.send(DigitalEvent.CloseDetail)
    eventChannel.send(DigitalEvent.Message(if (item.eventId == null) "已从本机删除" else "已从本机与电脑删除"))
  }
  fun selectDraft(id: String) {
    if (state.value.draft?.id == id) return
    val item = state.value.items.find { it.id == id } ?: return
    setDraft(item)
  }
  private fun setDraft(item: InboxItem?) {
    savedState["draft"] = item?.let { Json.encodeToString(it) }
    state.update { it.copy(draft = item) }
  }
  fun updateDraft(item: InboxItem) { if (!state.value.busy && item.status == "draft") setDraft(item) }
  fun discardDraft() { setDraft(null) }
  private suspend fun persistDraft() {
    val draft = state.value.draft ?: return
    val original = state.value.items.find { it.id == draft.id }
    val edited = draft.copy(projectId = draft.projectId.trim(), textOrigin = if (draft.text == original?.text) draft.textOrigin else "user-confirmed")
    withContext(Dispatchers.IO) { repository.inbox.saveDraft(edited) }; setDraft(edited)
  }
  fun saveDraft(close: Boolean = false) = action {
    persistDraft(); eventChannel.send(DigitalEvent.Message("已保存到本机"))
    if (close) { discardDraft(); eventChannel.send(DigitalEvent.CloseDetail) }
  }
  fun confirmSync() = action {
    persistDraft()
    val id = state.value.draft?.id ?: return@action
    repository.queue(id)
    setDraft(withContext(Dispatchers.IO) { repository.inbox.get(id) })
    val success = repository.sync()
    setDraft(withContext(Dispatchers.IO) { repository.inbox.get(id) })
    if (success) repository.refresh()
    eventChannel.send(DigitalEvent.Message(if (success) "已确认同步，请查看条目状态" else "内容已进入待同步队列"))
  }
  fun recognize() = action {
    // Preserve title/project/other edits before OCR replaces only the text.
    persistDraft()
    state.value.draft?.id?.let { setDraft(repository.recognize(it)) }
    eventChannel.send(DigitalEvent.Message("文字识别完成，请核对后再同步"))
  }
  fun editImage(left: Float, top: Float, right: Float, bottom: Float, mask: Boolean) = action {
    persistDraft()
    val id = state.value.draft?.id ?: return@action
    val edited = repository.editImage(id, left, top, right, bottom, mask)
    setDraft(edited); eventChannel.send(DigitalEvent.OpenDraft(edited.id))
    eventChannel.send(DigitalEvent.Message("已在本机修改图片；旧识别文字已清除，请重新识别并核对。"))
  }
  fun createPerson(name: String) = action {
    val draft = state.value.draft ?: return@action
    val person = repository.createPerson(name.trim(), draft.projectId.trim())
    setDraft(draft.copy(personId = person.getValue("personId").jsonPrimitive.content))
    repository.refresh(); eventChannel.send(DigitalEvent.Message("已创建独立人物"))
  }
  fun correct(event: JsonObject, text: String, personId: String?) = action {
    repository.correct(event, text, personId)
    val version = state.value.correctionVersion + 1
    savedState["correctionVersion"] = version
    state.update { it.copy(correctionVersion = version) }
    eventChannel.send(DigitalEvent.Message("纠正已保存"))
  }
  fun confirmFact(event: JsonObject, encounter: JsonObject, text: String, objectId: String? = null) = action {
    repository.confirmFact(event, encounter, text, objectId)
    eventChannel.send(DigitalEvent.Message("已由本人确认；原始来源保留，后续工作使用当前版本。"))
  }
  fun confirmMemory(memory: JsonObject, encounter: JsonObject, text: String) = action { repository.confirmMemory(memory, encounter, text); eventChannel.send(DigitalEvent.Message("现场或数字来源已关联到本人确认的约定。")) }
  fun linkContact(item: InboxItem, person: JsonObject, reject: Boolean) = action {
    repository.linkContact(item, person, reject); eventChannel.send(DigitalEvent.Message(if (reject) "已撤回联系人关联" else "已确认联系人关联"))
  }
  fun linkCommonPerson(event: JsonObject, digitalPerson: JsonObject, target: JsonObject) = action {
    repository.linkCommonPerson(event, digitalPerson, target); eventChannel.send(DigitalEvent.Message("已由本人关联两个来源中的人物，同名不会自动关联。"))
  }
  fun withdrawCommonPerson(target: JsonObject, linkId: String) = action { repository.withdrawCommonPerson(target, linkId); eventChannel.send(DigitalEvent.Message("已撤回人物关联，原始来源分别保留。")) }
}
