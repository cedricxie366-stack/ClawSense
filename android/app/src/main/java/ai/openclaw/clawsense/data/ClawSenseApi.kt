package ai.openclaw.clawsense.data

interface ClawSenseApi {
  suspend fun pair(
    host: String,
    token: String,
    deviceName: String,
    appVersion: String,
    fingerprint: String,
  ): DeviceSession

  suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip): IngestUploadResult

  suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame): IngestUploadResult

  suspend fun uploadVideo(session: DeviceSession, clip: CapturedVideoClip): IngestUploadResult

  suspend fun queryAssistant(session: DeviceSession, request: AssistantQueryRequest): AssistantQueryResponse

  suspend fun sendHeartbeat(session: DeviceSession, heartbeat: HeartbeatRequest): HeartbeatResult
}
