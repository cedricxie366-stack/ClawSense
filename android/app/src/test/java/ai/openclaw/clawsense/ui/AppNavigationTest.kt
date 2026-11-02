package ai.openclaw.clawsense.ui

import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.*
import ai.openclaw.clawsense.digital.shareItemId
import ai.openclaw.clawsense.ui.screens.*
import org.junit.Assert.*
import org.junit.Test

class AppNavigationTest {
  private val session = DeviceSession("http://192.168.1.2", "test", "fixture", "http://192.168.1.2/api/clawsense", 60, "test", 0)
  private val ready = MainUiState(session = session, runtimeStatus = ServiceRuntimeStatus(ServicePhase.RUNNING, CaptureMode.FULL))
  private val granted = PermissionSnapshot(true, true, true)

  @Test fun backUnwindsDetailThenReturnsToAssistant() {
    val nav = AppNavigation()
    assertEquals(AppTab.ASSISTANT, nav.tab)
    nav.select(AppTab.MEMORY); nav.open(AppDestination.DRAFT, "draft-1")
    assertTrue(nav.back()); assertEquals(AppTab.MEMORY, nav.tab); assertEquals(AppDestination.HOME, nav.destination)
    assertTrue(nav.back()); assertEquals(AppTab.ASSISTANT, nav.tab)
    assertFalse(nav.back())
  }
  @Test fun connectionOpenedFromAssistantReturnsToAssistant() {
    val nav = AppNavigation(); nav.open(AppDestination.SENSOR_CONNECTION); nav.back()
    assertEquals(AppTab.ASSISTANT, nav.tab); assertEquals(AppDestination.HOME, nav.destination)
  }
  @Test fun assistantProvidesTheCorrectPrerequisite() {
    assertEquals(AssistantGate.CONNECT, assistantGate(MainUiState(), granted, false))
    assertEquals(AssistantGate.HOST, assistantGate(ready, granted, true))
    assertEquals(AssistantGate.PERMISSION, assistantGate(ready, granted.copy(microphone = false), false))
    assertEquals(AssistantGate.PERMISSION, assistantGate(ready, granted.copy(notifications = false), false))
    assertEquals(AssistantGate.START, assistantGate(ready.copy(runtimeStatus = ServiceRuntimeStatus()), granted, false))
    assertEquals(AssistantGate.READY, assistantGate(ready, granted, false))
    assertEquals(AssistantGate.RESTART, assistantGate(ready.copy(runtimeStatus = ServiceRuntimeStatus(ServicePhase.RUNNING, CaptureMode.IMAGE_ONLY)), granted, false))
    assertEquals(AssistantGate.READY, assistantGate(ready, granted.copy(camera = false), false))
  }
  @Test fun assistantCannotSubmitTwiceWhileStartingRecordingWaitingOrSpeaking() {
    assertEquals(AssistantGate.BUSY, assistantGate(ready.copy(runtimeStatus = ServiceRuntimeStatus(ServicePhase.STARTING)), granted, false))
    assertEquals(AssistantGate.BUSY, assistantGate(ready.copy(runtimeStatus = ServiceRuntimeStatus(ServicePhase.STOPPING)), granted, false))
    listOf(AssistantInteractionPhase.RECORDING_QUERY, AssistantInteractionPhase.WAITING_ANSWER, AssistantInteractionPhase.SPEAKING_ANSWER).forEach {
      assertEquals(AssistantGate.BUSY, assistantGate(ready.copy(assistant = AssistantInteractionSnapshot(phase = it)), granted, false))
    }
  }
  @Test fun shareReplaysUseTheSameItemIdsButNewSharesRemainDistinct() {
    assertEquals(shareItemId("batch-1", 0), shareItemId("batch-1", 0))
    assertNotEquals(shareItemId("batch-1", 0), shareItemId("batch-1", 1))
    assertNotEquals(shareItemId("batch-1", 0), shareItemId("batch-2", 0))
    java.util.UUID.fromString(shareItemId("batch-1", 0))
  }
}
