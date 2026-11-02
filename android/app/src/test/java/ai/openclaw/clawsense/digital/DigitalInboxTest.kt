package ai.openclaw.clawsense.digital

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class DigitalInboxTest {
  @Test fun queueSurvivesRestartAndPayloadIsImmutable() {
    val directory = Files.createTempDirectory("digital-inbox-test").toFile()
    try {
      val inbox = DigitalInbox(directory)
      val draft = inbox.create(InboxItem(sourceType = "shared_text", title = "Test", text = "Friday"))
      inbox.queue(draft.id, "workspace-a")
      val restored = DigitalInbox(directory).get(draft.id)
      assertEquals("queued", restored.status); assertEquals("Friday", restored.text)
      assertThrows(IllegalStateException::class.java) { inbox.saveDraft(restored.copy(status = "draft", text = "Thursday")) }
      inbox.acknowledge(draft.id, "event-a", 1)
      assertEquals("uploaded", DigitalInbox(directory).get(draft.id).status)
    } finally { directory.deleteRecursively() }
  }
  @Test fun failedRetryCannotMoveToAnotherAccount() {
    val directory = Files.createTempDirectory("digital-inbox-test").toFile()
    try {
      val inbox = DigitalInbox(directory)
      val draft = inbox.create(InboxItem(sourceType = "shared_text", title = "Test"))
      inbox.queue(draft.id, "workspace-a"); inbox.failure(draft.id, "denied", true)
      assertThrows(IllegalStateException::class.java) { inbox.queue(draft.id, "workspace-b") }
      inbox.queue(draft.id, "workspace-a")
      assertEquals("queued", inbox.get(draft.id).status)
    } finally { directory.deleteRecursively() }
  }
  @Test fun imageIsRemovedWithDraftAndPathsStayInsideInbox() {
    val directory = Files.createTempDirectory("digital-inbox-test").toFile()
    try {
      val inbox = DigitalInbox(directory)
      val draft = inbox.create(InboxItem(sourceType = "shared_image", title = "Screenshot", mime = "image/png"), byteArrayOf(1, 2, 3))
      assertTrue(inbox.imageFile(draft.id).exists())
      assertThrows(IllegalArgumentException::class.java) { inbox.imageFile("../../outside") }
      inbox.remove(draft.id)
      assertFalse(inbox.imageFile(draft.id).exists()); assertTrue(inbox.list().isEmpty())
    } finally { directory.deleteRecursively() }
  }
  @Test fun editedImageGetsASeparateDraftAndDropsOldOcr() {
    val directory = Files.createTempDirectory("digital-edit-test").toFile()
    try {
      val inbox = DigitalInbox(directory)
      val original = inbox.create(InboxItem(sourceType = "shared_image", title = "截图", text = "旧的敏感识别文字", mime = "image/png"), byteArrayOf(1, 2, 3))
      val edited = inbox.replaceDraftImage(original.id, byteArrayOf(4, 5, 6))
      assertNotEquals(original.id, edited.id); assertEquals("", edited.text)
      assertFalse(inbox.imageFile(original.id).exists()); assertEquals(1, inbox.list().size)
      inbox.queue(edited.id, "account-a")
      assertThrows(IllegalStateException::class.java) { inbox.replaceDraftImage(edited.id, byteArrayOf(7)) }
    } finally { directory.deleteRecursively() }
  }
}
