package ai.openclaw.clawsense.ui

import ai.openclaw.clawsense.digital.*
import android.net.Uri
import android.content.ContentValues
import android.provider.MediaStore
import android.graphics.Bitmap
import androidx.lifecycle.SavedStateHandle
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class DigitalStateTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val repository get() = DigitalRepository(instrumentation.targetContext)
  private fun await(condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + 8_000
    while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(25)
    assertTrue("operation did not complete", condition())
  }
  @Test fun replayedTextShareImportsOnceAndRemainsAnUnqueuedDraft() {
    val repo = repository
    val batch = ShareBatch(mime = "text/plain", text = "UI test share", title = "Test ${UUID.randomUUID()}")
    val id = shareItemId(batch.id, 0)
    try {
      repeat(2) {
        lateinit var vm: ShareImportViewModel
        instrumentation.runOnMainSync { vm = ShareImportViewModel(repo, SavedStateHandle(mapOf("pending" to arrayListOf(Json.encodeToString(batch))))) }
        await { vm.completed.value != null }
        assertEquals(listOf(id), vm.completed.value!!.ids)
      }
      val drafts = repo.inbox.list().filter { it.id == id }
      assertEquals(1, drafts.size); assertEquals("draft", drafts.single().status); assertNull(drafts.single().target)
    } finally { repo.inbox.remove(id) }
  }
  @Test fun restoredUnsavedEditsStayLocalUntilExplicitSave() {
    val repo = repository
    val item = runBlocking { repo.createText("Original", "Local draft") }
    val edited = item.copy(text = "Unsubmitted edits")
    try {
      lateinit var vm: DigitalViewModel
      instrumentation.runOnMainSync { vm = DigitalViewModel(repo, SavedStateHandle(mapOf("draft" to Json.encodeToString(edited)))) }
      await { vm.uiState.value.loaded }
      assertEquals("Unsubmitted edits", vm.uiState.value.draft!!.text)
      assertTrue(vm.dirty)
      assertEquals("Original", repo.inbox.get(item.id).text)
      instrumentation.runOnMainSync { vm.saveDraft() }
      await { !vm.uiState.value.busy }
      assertEquals("Unsubmitted edits", repo.inbox.get(item.id).text)
      assertEquals("draft", repo.inbox.get(item.id).status)
      assertFalse(vm.dirty)
    } finally { repo.inbox.remove(item.id) }
  }
  @Test fun duplicateImageImportUsesItsStableIdBeforeReopeningUri() {
    val repo = repository
    val id = shareItemId(UUID.randomUUID().toString(), 0)
    val original = repo.inbox.create(InboxItem(id = id, sourceType = "shared_image", title = "Saved image", mime = "image/png"), byteArrayOf(1, 2, 3))
    try {
      val replay = runBlocking { repo.createImage(Uri.parse("content://expired-share/1"), id) }
      assertEquals(original, replay); assertEquals("draft", replay.status)
    } finally { repo.inbox.remove(id) }
  }
  @Test fun imageBatchIsCopiedLocallyAndReplaysWithoutDuplicateFiles() {
    val repo = repository
    val resolver = instrumentation.targetContext.contentResolver
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, "clawsense-ui-${UUID.randomUUID()}.png")
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ClawSenseUiValidation")
    })!!
    val bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888)
    resolver.openOutputStream(uri)!!.use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    val batch = ShareBatch(mime = "image/png", uris = listOf(uri.toString(), uri.toString()))
    val ids = listOf(shareItemId(batch.id, 0), shareItemId(batch.id, 1))
    try {
      repeat(2) {
        lateinit var vm: ShareImportViewModel
        instrumentation.runOnMainSync { vm = ShareImportViewModel(repo, SavedStateHandle(mapOf("pending" to arrayListOf(Json.encodeToString(batch))))) }
        await { vm.completed.value != null }
        assertEquals(ids, vm.completed.value!!.ids)
      }
      assertEquals(2, repo.inbox.list().count { it.id in ids })
      ids.forEach { id ->
        assertEquals("draft", repo.inbox.get(id).status)
        assertTrue(repo.inbox.imageFile(id).length() > 0)
        assertNull(repo.inbox.get(id).target)
      }
    } finally { ids.forEach(repo.inbox::remove); resolver.delete(uri, null, null) }
  }

}
