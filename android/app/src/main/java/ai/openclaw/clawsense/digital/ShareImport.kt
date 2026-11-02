package ai.openclaw.clawsense.digital

import android.net.Uri
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.util.UUID

@Serializable internal data class ShareBatch(val id: String = UUID.randomUUID().toString(), val mime: String, val text: String? = null, val title: String = "分享的文字", val uris: List<String> = emptyList())
@Serializable internal data class ShareResult(val id: String, val ids: List<String>, val message: String)
internal fun shareItemId(batchId: String, index: Int): String = UUID.nameUUIDFromBytes("clawsense-share/$batchId/$index".toByteArray(Charsets.UTF_8)).toString()

internal class ShareImportViewModel(private val repository: DigitalRepository, private val saved: SavedStateHandle) : ViewModel() {
  private val pending = saved.get<ArrayList<String>>("pending")?.toMutableList() ?: mutableListOf()
  private val result = MutableStateFlow(saved.get<String>("result")?.let { Json.decodeFromString<ShareResult>(it) })
  val completed = result.asStateFlow()
  private var processing = false
  init { process() }
  fun enqueue(batch: ShareBatch) {
    pending.add(Json.encodeToString(batch)); saved["pending"] = ArrayList(pending)
    saved["result"] = null; result.value = null; process()
  }
  private fun process() {
    if (processing || pending.isEmpty()) return
    processing = true
    viewModelScope.launch {
      val imported = mutableListOf<String>()
      var batchId = ""
      var errorMessage: String? = null
      while (pending.isNotEmpty()) {
        val batch = Json.decodeFromString<ShareBatch>(pending.first()); batchId = batch.id
        try {
          when {
            batch.mime == "text/plain" -> imported += repository.createText(batch.text ?: error("没有收到文字"), batch.title, shareItemId(batch.id, 0)).id
            batch.mime.startsWith("image/") -> {
              require(batch.uris.isNotEmpty()) { "没有收到图片" }
              require(batch.uris.size <= 10) { "一次最多分享 10 张图片" }
              batch.uris.forEachIndexed { index, uri -> imported += repository.createImage(Uri.parse(uri), shareItemId(batch.id, index)).id }
            }
            else -> error("请分享文字或图片")
          }
        } catch (error: Exception) { errorMessage = friendlyError(error) }
        // The deterministic item IDs make a replay after process recreation idempotent.
        val finished = ShareResult(batchId, imported.toList(), errorMessage ?: "已保存到本机，请检查后确认同步")
        saved["result"] = Json.encodeToString(finished)
        pending.removeAt(0); saved["pending"] = ArrayList(pending)
      }
      processing = false
      result.value = saved.get<String>("result")?.let { Json.decodeFromString<ShareResult>(it) }
    }
  }
}
