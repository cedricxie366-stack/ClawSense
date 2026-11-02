package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.data.AssistantInteractionPhase
import ai.openclaw.clawsense.data.AssistantInteractionSnapshot

internal fun rejectBusyAssistantQuery(snapshot: AssistantInteractionSnapshot, now: Long): AssistantInteractionSnapshot? =
  if (snapshot.phase in listOf(AssistantInteractionPhase.RECORDING_QUERY, AssistantInteractionPhase.WAITING_ANSWER, AssistantInteractionPhase.SPEAKING_ANSWER)) {
    snapshot.copy(lastUpdatedAt = now, lastError = "助手正在处理上一轮问题，请等它说完再问。")
  } else null

internal fun stoppedAssistantSnapshot(snapshot: AssistantInteractionSnapshot, now: Long): AssistantInteractionSnapshot =
  snapshot.copy(phase = AssistantInteractionPhase.PASSIVE_SENSING, lastUpdatedAt = now)
