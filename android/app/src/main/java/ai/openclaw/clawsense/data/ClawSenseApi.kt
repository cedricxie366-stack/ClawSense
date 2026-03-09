package ai.openclaw.clawsense.data

interface ClawSenseApi {
  suspend fun pair(
    host: String,
    token: String,
    deviceName: String,
    appVersion: String,
    fingerprint: String,
  ): DeviceSession

  suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip)

  suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame)

  suspend fun sendHeartbeat(session: DeviceSession, heartbeat: HeartbeatRequest): Int
}
