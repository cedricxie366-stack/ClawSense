package ai.openclaw.clawsense.sensors

import org.junit.Assert.*
import org.junit.Test

class AmbientAudioIsolationTest {
  @Test fun waitingAndPlaybackCannotBecomeALaterAmbientClip() {
    val isolation = AmbientAudioIsolation()
    val buffer = StringBuilder()
    fun frame(text: String) { if (isolation.allowFrame { buffer.clear() }) buffer.append(text) }
    frame("conversation before query")
    isolation.setSuppressed(true)
    frame("query tail")
    frame("assistant playback")
    frame("speaker drain")
    assertEquals("", buffer.toString())
    isolation.setSuppressed(false)
    frame("new human conversation")
    assertEquals("new human conversation", buffer.toString())
  }

  @Test fun pauseAndResumeBetweenReadsStillDiscardsThePreviousPreRoll() {
    val isolation = AmbientAudioIsolation()
    val buffer = StringBuilder("old partial clip")
    isolation.setSuppressed(true)
    isolation.setSuppressed(false)
    assertTrue(isolation.allowFrame { buffer.clear() })
    buffer.append("new words")
    assertEquals("new words", buffer.toString())
  }

  @Test fun ordinaryFramesAndRepeatedReadyNotificationsKeepAConversationIntact() {
    val isolation = AmbientAudioIsolation()
    val buffer = StringBuilder()
    for (word in listOf("meeting ", "tomorrow ", "at three")) {
      isolation.setSuppressed(false)
      if (isolation.allowFrame { buffer.clear() }) buffer.append(word)
    }
    assertEquals("meeting tomorrow at three", buffer.toString())
  }
}
