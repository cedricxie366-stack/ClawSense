package ai.openclaw.clawsense.live
import org.junit.Assert.*
import org.junit.Test
class LiveEventGateTest {
  @Test fun oldTurnAudioDoesNotResumeAfterInterruption() {
    val gate = LiveEventGate(); gate.ready("s")
    assertTrue(gate.accept("s", "a", 1, "turn_started"))
    assertTrue(gate.accept("s", "a", 2, "audio"))
    gate.interrupt()
    assertFalse(gate.accept("s", "a", 3, "audio"))
    assertTrue(gate.accept("s", "b", 4, "turn_started"))
    assertFalse(gate.accept("s", "a", 5, "audio"))
    assertTrue(gate.accept("s", "b", 6, "audio"))
  }
  @Test fun rejectsDuplicateSequenceAndPreviousConnection() {
    val gate = LiveEventGate(); gate.ready("s")
    assertTrue(gate.accept("s", "a", 1, "turn_started"))
    assertFalse(gate.accept("s", "a", 1, "text_delta"))
    assertFalse(gate.accept("old", "a", 2, "audio"))
    gate.ready("new")
    assertFalse(gate.accept("s", "a", 3, "audio"))
  }
  @Test fun preservesTranscriptWhenNoAnswerTurnStarted() {
    val gate = LiveEventGate(); gate.ready("s")
    assertTrue(gate.accept("s", "", 1, "transcript"))
    assertFalse(gate.accept("s", "", 2, "audio"))
  }
}

class LivePreparationFailureGateTest {
  @org.junit.Test fun preparationFailureAfterInterruptIsVisibleButOldAudioRemainsBlocked() {
    val gate = LiveEventGate(); gate.ready("s")
    org.junit.Assert.assertTrue(gate.accept("s", "old", 1, "turn_started"))
    org.junit.Assert.assertTrue(gate.accept("s", "old", 2, "completed"))
    org.junit.Assert.assertTrue(gate.accept("s", "old", 3, "interrupted"))
    org.junit.Assert.assertTrue(gate.accept("s", "preparing", 4, "error"))
    org.junit.Assert.assertFalse(gate.accept("s", "old", 5, "audio"))
    org.junit.Assert.assertTrue(gate.accept("s", "new", 6, "turn_started"))
    org.junit.Assert.assertFalse(gate.accept("s", "preparing", 7, "configuration_required"))
    org.junit.Assert.assertTrue(gate.accept("s", "new", 8, "audio"))
  }
}
