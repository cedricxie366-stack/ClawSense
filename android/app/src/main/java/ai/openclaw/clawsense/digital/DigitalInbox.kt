package ai.openclaw.clawsense.digital

import java.io.File
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

@Serializable
data class InboxItem(
  val id: String = UUID.randomUUID().toString(),
  val sourceType: String,
  val capturedAt: Long = System.currentTimeMillis(),
  val title: String,
  val text: String = "",
  val textOrigin: String = "user-confirmed",
  val mime: String? = null,
  val projectId: String = "inbox",
  val personId: String? = null,
  val sessionId: String? = null,
  val claimedApp: String? = null,
  val contact: SelectedContact? = null,
  val status: String = "draft",
  val target: String? = null,
  val eventId: String? = null,
  val revision: Int? = null,
  val error: String? = null,
  val replacementId: String? = null,
)

@Serializable
data class SelectedContact(val displayName: String, val externalId: String, val phone: String? = null)

/** App-private persistent drafts. Queued payloads stay immutable across retries. */
class DigitalInbox(private val directory: File) {
  private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true; explicitNulls = false }
  init { check(directory.exists() || directory.mkdirs()); recoverEdits() }
  private fun recoverEdits() {
    directory.listFiles().orEmpty().filter { it.name.endsWith(".json") }.forEach { file ->
      val item = json.decodeFromString<InboxItem>(file.readText())
      if (item.status == "editing") {
        if (item.replacementId != null && record(item.replacementId).exists() && imageFile(item.replacementId).exists()) remove(item.id)
        else persist(item.copy(status = "draft", replacementId = null, error = "裁剪或遮挡尚未完成，请重新检查原图。"))
      }
    }
  }

  @Synchronized fun list(): List<InboxItem> = directory.listFiles().orEmpty().filter { it.name.endsWith(".json") }.map {
    // Fail visibly on corruption instead of silently dropping a user's draft.
    json.decodeFromString<InboxItem>(it.readText())
  }.sortedByDescending { it.capturedAt }

  @Synchronized fun get(id: String): InboxItem = json.decodeFromString(record(id).readText())
  @Synchronized fun create(item: InboxItem, image: ByteArray? = null): InboxItem {
    check(!record(item.id).exists()) { "条目已存在" }
    check(list().size < 200) { "收件箱已满，请先删除不用的内容" }
    val bytes = directory.listFiles().orEmpty().sumOf { it.length() }
    check(bytes + (image?.size ?: 0) + item.text.toByteArray().size < 128L * 1024 * 1024) { "收件箱空间已满" }
    check(image == null || image.size <= 8 * 1024 * 1024) { "图片超过 8 MB，请裁剪后分享" }
    if (image != null) imageFile(item.id).writeBytes(image)
    try { persist(item) } catch (error: Exception) { imageFile(item.id).delete(); throw error }
    return item
  }
  @Synchronized fun saveDraft(item: InboxItem) {
    check(get(item.id).status == "draft" && item.status == "draft") { "已入队的内容不能修改，请纠正已同步记忆" }
    require(item.title.isNotBlank() && item.title.length <= 300 && item.text.length <= 64_000)
    require(item.projectId.isNotBlank() && item.projectId.length <= 200)
    persist(item)
  }
  @Synchronized fun replaceDraftImage(id: String, bytes: ByteArray): InboxItem {
    val item = get(id); check(item.status == "draft" && item.sourceType == "shared_image")
    require(bytes.isNotEmpty() && bytes.size <= 8 * 1024 * 1024)
    // Replacing bytes under the same id could recover old OCR after a crash. Create a new
    // complete draft first, then remove the old one; a crash can leave two drafts, never a mismatched payload.
    val nextId = UUID.randomUUID().toString()
    persist(item.copy(status = "editing", replacementId = nextId))
    try {
      val replacement = create(item.copy(id = nextId, text = "", mime = "image/jpeg", textOrigin = "device-ocr", replacementId = null), bytes)
      remove(id); return replacement
    } catch (error: Exception) { persist(item); throw error }
  }
  @Synchronized fun queue(id: String, target: String): InboxItem {
    val item = get(id)
    check(item.status == "draft" || item.status == "failed")
    check(item.target == null || item.target == target) { "条目属于另一个配对，请先切回原配对" }
    return item.copy(status = "queued", target = target, error = null).also { persist(it) }
  }
  @Synchronized fun acknowledge(id: String, eventId: String, revision: Int) {
    val item = get(id)
    persist(item.copy(status = "uploaded", eventId = eventId, revision = revision, error = null))
  }
  @Synchronized fun failure(id: String, message: String, permanent: Boolean) {
    persist(get(id).copy(status = if (permanent) "failed" else "queued", error = message))
  }
  @Synchronized fun remove(id: String) { record(id).delete(); imageFile(id).delete() }
  fun imageFile(id: String): File { validId(id); return File(directory, "$id.image") }
  private fun record(id: String): File { validId(id); return File(directory, "$id.json") }
  private fun validId(id: String) { require(Regex("^[a-f0-9-]{36}$").matches(id)) }
  private fun persist(item: InboxItem) {
    val destination = record(item.id)
    val temporary = File(directory, "${item.id}.${UUID.randomUUID()}.tmp")
    try {
      temporary.outputStream().use { stream -> stream.write(json.encodeToString(item).toByteArray()); stream.fd.sync() }
      check(temporary.renameTo(destination)) { "保存失败，请重试" }
    } finally { temporary.delete() }
  }
}
