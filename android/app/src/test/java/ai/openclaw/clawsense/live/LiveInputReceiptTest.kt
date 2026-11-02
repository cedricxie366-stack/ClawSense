package ai.openclaw.clawsense.live

import org.junit.Assert.*
import org.junit.Test

class LiveInputReceiptTest {
  @Test fun lateOldDecisionAndComparisonCannotOverwriteTheNewUtterance() {
    val newer = LiveInputReceipt().update(2, "recognizing").update(2, "accepted")
    assertEquals(newer, newer.update(1, "no_transcript"))
    assertEquals(newer, newer.compare(1, "old selected", "old private alternative"))
    assertEquals(newer, newer.update(2, "recognizing"))
  }

  @Test fun alternativesAreBoundedAndClearedForTheNextUtterance() {
    val selected = LiveInputReceipt().update(1, "accepted").compare(1, "IP排", "安排".repeat(400))
    assertEquals(400, selected.alternative.length)
    assertTrue(selected.update(2, "recognizing").alternative.isEmpty())
    assertEquals(LiveInputReceipt(), LiveInputReceipt().compare(1, "selected", "alternative"))
  }

  @Test fun unknownServerCodesAreNotRenderedAsProductText() {
    val current = LiveInputReceipt().update(1, "recognizing")
    assertEquals(current, current.update(2, "unexpected_private_material"))
    assertNull(liveInputStatusLabel("unexpected_private_material"))
    assertFalse(liveInputStatusLabel("accepted")!!.contains("已确认"))
    assertFalse(liveInputStatusLabel("accepted")!!.contains("已保存"))
  }
}
