package ai.openclaw.clawsense.service

import org.junit.Assert.*
import org.junit.Test

class SpeechChunksTest {
  @Test fun longChineseAnswerKeepsItsEndingAndRespectsTheEngineLimit() {
    val text = "小林希望周五收到方案，预算三万元。".repeat(350) + "这是最后一句。"
    val chunks = speechChunks(text, 4000)
    assertTrue(chunks.size > 1)
    assertTrue(chunks.all { it.length <= 4000 })
    assertEquals(text, chunks.joinToString(""))
    assertTrue(chunks.last().endsWith("这是最后一句。"))
  }

  @Test fun doesNotSeparateAnEmojiSurrogatePairAtTheEngineBoundary() {
    val text = "甲".repeat(9) + "😀" + "乙".repeat(12)
    val chunks = speechChunks(text, 10)
    assertEquals(text, chunks.joinToString(""))
    assertTrue(chunks.all { it.length <= 10 })
    assertTrue(chunks.none { it.last().isHighSurrogate() || it.first().isLowSurrogate() })
  }

  @Test fun prefersSentenceBoundariesWithoutDroppingWhitespace() {
    val text = "一二三四五。 六七八九十十一十二十三。末句。"
    val chunks = speechChunks(text, 10)
    assertEquals("一二三四五。", chunks.first())
    assertEquals(text, chunks.joinToString(""))
  }

  @Test fun blankTextHasNoUtterance() {
    assertTrue(speechChunks("  \n  ", 4000).isEmpty())
  }
}
