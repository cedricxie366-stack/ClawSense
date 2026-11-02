package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.data.AssistantInteractionPhase
import ai.openclaw.clawsense.data.AssistantInteractionSnapshot
import ai.openclaw.clawsense.data.AssistantModeHint
import org.junit.Assert.*
import org.junit.Test

class AssistantLifecycleTest {
  @Test fun repeatedQueryCannotInvalidateRecordingWaitingOrPlayback() {
    for (phase in listOf(AssistantInteractionPhase.RECORDING_QUERY, AssistantInteractionPhase.WAITING_ANSWER, AssistantInteractionPhase.SPEAKING_ANSWER)) {
      val current = AssistantInteractionSnapshot(phase = phase, queryText = "first query", answerText = "previous answer", answeredAt = 10L)
      val rejected = requireNotNull(rejectBusyAssistantQuery(current, 20L))
      assertEquals(phase, rejected.phase)
      assertEquals(current.queryText, rejected.queryText)
      assertEquals(current.answerText, rejected.answerText)
      assertEquals(10L, rejected.answeredAt)
    }
  }

  @Test fun stoppingSensingRetainsTheLastAnswerAndItsOriginalTimestamp() {
    val current = AssistantInteractionSnapshot(phase = AssistantInteractionPhase.SPEAKING_ANSWER, mode = AssistantModeHint.MEETING, queryText = "会议几点开始", answerText = "明天下午三点", answerSpokenText = "明天下午三点", answeredAt = 10L)
    val stopped = stoppedAssistantSnapshot(current, 20L)
    assertEquals(AssistantInteractionPhase.PASSIVE_SENSING, stopped.phase)
    assertEquals(AssistantModeHint.MEETING, stopped.mode)
    assertEquals(current.queryText, stopped.queryText)
    assertEquals(current.answerText, stopped.answerText)
    assertEquals(current.answerSpokenText, stopped.answerSpokenText)
    assertEquals(10L, stopped.answeredAt)
    assertEquals(20L, stopped.lastUpdatedAt)
  }

  @Test fun readyAndStoppedStatesAllowTheNextExplicitQuery() {
    for (phase in listOf(AssistantInteractionPhase.WAKEWORD_ARMED, AssistantInteractionPhase.PASSIVE_SENSING, AssistantInteractionPhase.ERROR_RECOVERY)) {
      assertNull(rejectBusyAssistantQuery(AssistantInteractionSnapshot(phase = phase), 20L))
    }
  }
}
