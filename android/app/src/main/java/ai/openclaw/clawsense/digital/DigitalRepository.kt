package ai.openclaw.clawsense.digital

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.BuildConfig
import ai.openclaw.clawsense.data.DeviceSession
import ai.openclaw.clawsense.data.SetupCodeParser
import android.content.Context
import android.net.Uri
import android.util.Base64
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.io.File
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class DigitalApiError(val code: String, val status: Int): Exception(code)

class DigitalRepository(private val context: Context) {
  val inbox = DigitalInbox(File(context.noBackupFilesDir, "digital-inbox"))
  private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
  private val mutex = Mutex()
  private val cache = File(context.noBackupFilesDir, "digital-cache.json")
  private val json = Json { encodeDefaults = true; explicitNulls = false }
  fun releaseIdleConnections() { client.connectionPool.evictAll() }
  fun session(): DeviceSession? = AppGraph.sessionStore(context).loadPrimarySession()
  fun target(session: DeviceSession): String = "${session.host}|${session.memoryNamespace}|${session.deviceId}"
  private fun cacheTarget(session: DeviceSession) = target(session) + "|" + java.security.MessageDigest.getInstance("SHA-256").digest(session.deviceSecret.toByteArray()).joinToString("") { "%02x".format(it) }

  suspend fun pair(code: String) {
    val setup = SetupCodeParser.parse(code) ?: error("配对码无法解析，请重新扫码")
    if (setup.warning != null && !(BuildConfig.DEBUG && URI(setup.host).host in listOf("localhost", "127.0.0.1", "::1"))) error(setup.warning)
    val session = AppGraph.api(context).pair(host = setup.host, token = setup.token, deviceName = "主手机 · ${android.os.Build.MODEL}", appVersion = BuildConfig.VERSION_NAME, fingerprint = AppGraph.sessionStore(context).primaryFingerprint())
    check(session.digitalContextEnabled) { "请在电脑选择“主手机”生成配对码；普通采集二维码没有数字记忆权限" }
    AppGraph.sessionStore(context).savePrimarySession(session)
    refresh()
  }

  suspend fun createText(text: String, title: String = "分享的文字", id: String = UUID.randomUUID().toString()): InboxItem = withContext(Dispatchers.IO) {
    inbox.list().find { it.id == id }?.let { return@withContext it }
    require(text.length <= 64_000) { "文字超过限制，请分段分享" }
    inbox.create(InboxItem(id = id, sourceType = "shared_text", title = title.take(300), text = text))
  }
  suspend fun createImage(uri: Uri, id: String = UUID.randomUUID().toString()): InboxItem = withContext(Dispatchers.IO) {
    inbox.list().find { it.id == id }?.let { return@withContext it }
    val mime = context.contentResolver.getType(uri) ?: error("无法识别图片格式")
    require(mime in listOf("image/png", "image/jpeg", "image/webp")) { "仅支持 PNG、JPEG、WebP 图片" }
    val image = context.contentResolver.openInputStream(uri)?.use { it.readBytesBounded(8 * 1024 * 1024) } ?: error("无法打开图片，请重新分享")
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(image, 0, image.size, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 16_000_000) { "图片尺寸过大或损坏，请裁剪后分享" }
    val item = inbox.create(InboxItem(id = id, sourceType = "shared_image", title = "分享的截图", mime = mime), image)
    // Save before OCR so a model error or process interruption never discards the image.
    item
  }
  suspend fun recognize(id: String): InboxItem {
    val item = withContext(Dispatchers.IO) { inbox.get(id) }
    check(item.status == "draft" && item.sourceType == "shared_image")
    val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    try {
      val input = withContext(Dispatchers.IO) { InputImage.fromFilePath(context, Uri.fromFile(inbox.imageFile(id))) }
      val result = suspendCancellableCoroutine<String> { continuation ->
        recognizer.process(input).addOnSuccessListener { if (continuation.isActive) continuation.resume(it.text) }
          .addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(it) }
      }
      return withContext(Dispatchers.IO) { item.copy(text = result.take(64_000), textOrigin = "device-ocr").also { inbox.saveDraft(it) } }
    } finally { recognizer.close() }
  }
  suspend fun editImage(id: String, left: Float, top: Float, right: Float, bottom: Float, mask: Boolean): InboxItem = withContext(Dispatchers.IO) {
    require(listOf(left, top, right, bottom).all { it.isFinite() && it in 0f..1f } && right > left && bottom > top) { "请选择有效区域" }
    val original = android.graphics.BitmapFactory.decodeFile(inbox.imageFile(id).path) ?: error("图片无法读取")
    val x = (left * original.width).toInt().coerceIn(0, original.width - 1)
    val y = (top * original.height).toInt().coerceIn(0, original.height - 1)
    val width = ((right - left) * original.width).toInt().coerceIn(1, original.width - x)
    val height = ((bottom - top) * original.height).toInt().coerceIn(1, original.height - y)
    val edited = if (mask) original.copy(android.graphics.Bitmap.Config.ARGB_8888, true).also { android.graphics.Canvas(it).drawRect(x.toFloat(), y.toFloat(), (x + width).toFloat(), (y + height).toFloat(), android.graphics.Paint().apply { color = android.graphics.Color.BLACK }) } else android.graphics.Bitmap.createBitmap(original, x, y, width, height)
    val output = java.io.ByteArrayOutputStream(); edited.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, output)
    if (edited !== original) edited.recycle(); original.recycle()
    inbox.replaceDraftImage(id, output.toByteArray())
  }
  suspend fun createContact(contact: SelectedContact): InboxItem = withContext(Dispatchers.IO) {
    inbox.create(InboxItem(sourceType = "contact_selection", title = "选择的联系人 · ${contact.displayName}".take(300), text = listOfNotNull(contact.displayName, contact.phone).joinToString("\n"), contact = contact))
  }
  suspend fun createPerson(name: String, projectId: String): JsonObject = post("person", buildJsonObject { put("displayName", name); put("projectId", projectId) }).getValue("person").jsonObject
  suspend fun createEncounter(title: String, projectId: String, previousSessionId: String? = null): JsonObject = post("encounter", buildJsonObject { put("title", title); put("projectId", projectId); previousSessionId?.let { put("previousSessionId", it) } }).getValue("session").jsonObject
  suspend fun refresh(): JsonObject {
    val active = session() ?: error("请先配对主手机")
    val result = try { post("bootstrap", buildJsonObject {}, active) } catch (error: DigitalApiError) { if (error.status in listOf(401, 403, 410)) withContext(Dispatchers.IO) { cache.delete() }; throw error }
    withContext(Dispatchers.IO) { val contents = buildJsonObject { put("target", cacheTarget(active)); put("savedAt", System.currentTimeMillis()); put("expiresAt", System.currentTimeMillis() + 24 * 3600000L); put("data", result) }.toString(); check(contents.toByteArray().size <= 2 * 1024 * 1024) { "缓存超过容量，请缩小项目范围" }; val temp = File(cache.path + ".tmp"); temp.writeText(contents); check(temp.renameTo(cache)) }
    return result
  }
  suspend fun cached(): JsonObject? = withContext(Dispatchers.IO) {
    val active = session() ?: return@withContext null
    if (!cache.exists()) return@withContext null
    val value = json.parseToJsonElement(cache.readText()).jsonObject
    if (value["target"]?.jsonPrimitive?.content == cacheTarget(active) && (value["expiresAt"]?.jsonPrimitive?.longOrNull ?: 0L) > System.currentTimeMillis() && (value["savedAt"]?.jsonPrimitive?.longOrNull ?: Long.MAX_VALUE) <= System.currentTimeMillis()) value["data"]?.jsonObject?.let { JsonObject(it + ("cacheSavedAt" to (value["savedAt"] ?: JsonPrimitive(0))) + ("cacheExpiresAt" to value["expiresAt"]!!)) } else { cache.delete(); null }
  }
  suspend fun queue(id: String) {
    val active = session() ?: error("请先配对主手机")
    withContext(Dispatchers.IO) { inbox.queue(id, target(active)) }
    DigitalSyncWorker.schedule(context)
  }
  suspend fun sync(): Boolean = mutex.withLock {
    val active = session() ?: return@withLock false
    var retry = false
    val items = withContext(Dispatchers.IO) { inbox.list().filter { it.status == "queued" && it.target == target(active) } }
    for (item in items) {
      try {
        val payload = withContext(Dispatchers.IO) { buildJsonObject {
          put("clientEventId", item.id); put("projectId", item.projectId); put("sourceType", item.sourceType); put("capturedAt", item.capturedAt)
          put("title", item.title); put("text", item.text); put("textOrigin", item.textOrigin)
          item.personId?.let { put("personId", it) }; item.sessionId?.let { put("sessionId", it) }; item.claimedApp?.takeIf { it.isNotBlank() }?.let { put("claimedApp", it) }
          item.contact?.let { put("contact", json.encodeToJsonElement(it)) }
          item.mime?.let { put("mime", it); put("imageBase64", Base64.encodeToString(inbox.imageFile(item.id).readBytes(), Base64.NO_WRAP)) }
        } }
        val response = post("ingest", payload, active)
        check(response["stored"]?.jsonPrimitive?.booleanOrNull == true) { "主机尚未确认保存" }
        val event = response.getValue("event").jsonObject
        withContext(Dispatchers.IO) { inbox.acknowledge(item.id, event.getValue("eventId").jsonPrimitive.content, event.getValue("revision").jsonPrimitive.int) }
      } catch (error: Exception) {
        val permanent = error is DigitalApiError && error.status in 400..499 && error.status != 429
        withContext(Dispatchers.IO) { inbox.failure(item.id, friendlyError(error), permanent) }
        retry = retry || !permanent
      }
    }
    !retry
  }
  suspend fun correct(event: JsonObject, text: String, personId: String?) {
    post("correct", buildJsonObject { put("eventId", event.getValue("eventId")); put("expectedRevision", event.getValue("revision")); put("text", text); if (personId == null) put("clearPerson", true) else put("personId", personId) })
    refresh()
  }
  suspend fun confirmFact(event: JsonObject, encounter: JsonObject, text: String, objectId: String? = null) {
    check(event["projectId"] == encounter["projectId"]) { "请选择同一项目的面谈" }
    post("confirm", buildJsonObject {
      put("sessionId", encounter.getValue("sessionId")); put("expectedRevision", encounter.getValue("revision")); put("text", text)
      objectId?.let { put("objectId", it) }
      put("sourceRefs", buildJsonArray { add(buildJsonObject { put("kind", "digital-evidence"); put("id", event.getValue("eventId")); put("revision", event.getValue("revision")) }) })
    }); refresh()
  }
  suspend fun confirmMemory(memory: JsonObject, encounter: JsonObject, text: String) {
    check(memory["projectIds"]?.jsonArray.orEmpty().contains(encounter["projectId"])) { "请选择来源所在项目的面谈" }
    post("confirm", buildJsonObject { put("sessionId", encounter.getValue("sessionId")); put("expectedRevision", encounter.getValue("revision")); put("text", text); if (memory["ref"]?.jsonObject?.get("kind")?.jsonPrimitive?.content == "assertion" && memory["sessionId"] == encounter["sessionId"]) memory["objectId"]?.let { put("objectId", it) }; put("sourceRefs", buildJsonArray { add(memory.getValue("ref")) }) }); refresh()
  }
  suspend fun reviewResult(resultId: String, revision: Int, accept: Boolean, supersedes: String? = null) {
    post("review", buildJsonObject { put("resultId", resultId); put("expectedRevision", revision); put("state", if (accept) "accepted" else "rejected"); supersedes?.let { put("supersedesResultId", it) } }); refresh()
  }
  suspend fun delete(item: InboxItem) = mutex.withLock {
    if (item.eventId != null) {
      val active = session() ?: error("请切回原配对后删除")
      check(item.target == target(active)) { "请切回原配对后删除" }
      post("delete", buildJsonObject { put("eventId", item.eventId) }, active)
    }
    withContext(Dispatchers.IO) { inbox.remove(item.id) }
    if (session() != null) runCatching { refresh() }
    Unit
  }
  suspend fun linkContact(item: InboxItem, person: JsonObject, reject: Boolean = false) {
    val active = session() ?: error("请先配对主手机")
    val contact = item.contact ?: error("此条目不是联系人")
    check(item.target == target(active)) { "请切回原配对后确认" }
    post("identity", buildJsonObject {
      put("personId", person.getValue("personId")); put("expectedRevision", person.getValue("revision"))
      put("platform", "android-contacts"); put("accountRef", active.deviceId); put("externalId", contact.externalId); put("label", contact.displayName); put("reject", reject)
    })
    refresh()
  }
  suspend fun linkCommonPerson(event: JsonObject, digitalPerson: JsonObject, target: JsonObject) {
    val canonical = digitalPerson["canonicalPersonId"]?.jsonPrimitive?.content ?: error("请先刷新人物资料")
    post("link-person", buildJsonObject { put("personId", target.getValue("personId")); put("otherPersonId", canonical); put("expectedRevision", target.getValue("revision")); put("sourceRefs", buildJsonArray { add(buildJsonObject { put("kind", "digital-evidence"); put("id", event.getValue("eventId")) }) }) }); refresh()
  }
  suspend fun withdrawCommonPerson(target: JsonObject, linkId: String) {
    post("link-person", buildJsonObject { put("personId", target.getValue("personId")); put("expectedRevision", target.getValue("revision")); put("withdrawLinkId", linkId); put("sourceRefs", JsonArray(emptyList())) }); refresh()
  }
  private suspend fun post(route: String, body: JsonObject, active: DeviceSession = session() ?: error("请先配对主手机")): JsonObject = withContext(Dispatchers.IO) {
    val request = Request.Builder().url("${active.uploadBaseUrl.trimEnd('/')}/digital/$route").header("Authorization", "Bearer ${active.deviceSecret}")
      .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()
    client.newCall(request).execute().use { response ->
      val raw = response.body?.string() ?: error("主机未返回内容")
      val value = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrElse { error("主机响应格式不正确") }
      if (!response.isSuccessful || value["ok"]?.jsonPrimitive?.booleanOrNull != true) throw DigitalApiError(value["error"]?.jsonPrimitive?.content ?: "host_unavailable", response.code)
      value
    }
  }
}

private fun java.io.InputStream.readBytesBounded(limit: Int): ByteArray {
  val result = java.io.ByteArrayOutputStream()
  val buffer = ByteArray(8192)
  while (true) { val read = read(buffer); if (read < 0) break; require(result.size() + read <= limit) { "图片超过 8 MB，请裁剪后分享" }; result.write(buffer, 0, read) }
  return result.toByteArray()
}
fun friendlyError(error: Exception): String = when ((error as? DigitalApiError)?.code) {
  "primary_device_authorization_required" -> "主手机授权未开启或已被撤销，请重新生成主手机配对码"
  "revision_conflict" -> "内容已被更正，请刷新后重试"
  "context_deleted" -> "内容已被删除，不能通过重试恢复"
  "person_project_mismatch" -> "人物与项目不匹配，请选择该项目中的人物"
  else -> if (error is java.io.IOException) "暂时连不上电脑；内容已在本机保留" else error.message ?: "操作失败，请重试"
}
