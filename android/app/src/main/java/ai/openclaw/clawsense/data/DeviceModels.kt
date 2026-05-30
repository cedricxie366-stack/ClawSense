package ai.openclaw.clawsense.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DeviceSession(
  val host: String,
  val deviceId: String,
  val deviceSecret: String,
  val uploadBaseUrl: String,
  val heartbeatIntervalSec: Int,
  val memoryNamespace: String,
  val pairedAt: Long,
)

data class PairingSetup(
  val host: String,
  val token: String,
  val warning: String? = null,
)

@Serializable
data class PairingRequest(
  @SerialName("setupToken") val setupToken: String,
  @SerialName("deviceName") val deviceName: String,
  @SerialName("platform") val platform: String = "android",
  @SerialName("appVersion") val appVersion: String,
  @SerialName("fingerprint") val fingerprint: String,
)

@Serializable
data class PairingResponse(
  val ok: Boolean,
  val deviceId: String,
  val deviceSecret: String,
  val uploadBaseUrl: String,
  val heartbeatIntervalSec: Int = 60,
  val memoryNamespace: String = "clawsense",
  val pairedAt: Long,
)

@Serializable
data class AudioUploadRequest(
  val audioBase64: String,
  val fileName: String,
  val mime: String,
  val capturedAt: Long,
  val note: String? = null,
)

@Serializable
data class ImageUploadRequest(
  val imageBase64: String,
  val fileName: String,
  val mime: String,
  val capturedAt: Long,
  val note: String? = null,
)

@Serializable
data class HeartbeatRequest(
  val batteryPct: Double? = null,
  val network: String? = null,
  val appState: String? = null,
)

data class CapturedAudioClip(
  val bytes: ByteArray,
  val mime: String = "audio/wav",
  val fileName: String = "capture.wav",
  val capturedAt: Long = System.currentTimeMillis(),
  val durationMs: Long? = null,
  val note: String? = null,
)

data class CapturedImageFrame(
  val bytes: ByteArray,
  val mime: String = "image/jpeg",
  val fileName: String = "snapshot.jpg",
  val capturedAt: Long = System.currentTimeMillis(),
  val note: String? = null,
)

data class CapturedVideoKeyframe(
  val image: CapturedImageFrame,
  val videoOffsetMs: Long,
)

data class CapturedVideoClip(
  val bytes: ByteArray,
  val mime: String = "video/mp4",
  val fileName: String = "capture.mp4",
  val capturedAt: Long = System.currentTimeMillis(),
  val durationMs: Long? = null,
  val note: String? = null,
  val keyframes: List<CapturedVideoKeyframe> = emptyList(),
)

@Serializable
data class VideoUploadKeyframeRequest(
  val imageBase64: String,
  val fileName: String,
  val mime: String,
  val capturedAt: Long,
  val note: String? = null,
  val videoOffsetMs: Long,
)

@Serializable
data class VideoUploadRequest(
  val videoBase64: String,
  val fileName: String,
  val mime: String,
  val capturedAt: Long,
  val note: String? = null,
  val keyframes: List<VideoUploadKeyframeRequest> = emptyList(),
)

@Serializable
data class ServiceRuntimeStatus(
  val phase: ServicePhase = ServicePhase.STOPPED,
  val mode: CaptureMode = CaptureMode.NONE,
  val updatedAt: Long = System.currentTimeMillis(),
  val lastError: String? = null,
)

@Serializable
enum class ServicePhase {
  STOPPED,
  STARTING,
  RUNNING,
  ERROR,
}

@Serializable
enum class CaptureMode {
  NONE,
  FULL,
  AUDIO_ONLY,
  IMAGE_ONLY,
}

@Serializable
enum class AssistantInteractionPhase {
  PASSIVE_SENSING,
  WAKEWORD_ARMED,
  RECORDING_QUERY,
  WAITING_ANSWER,
  SPEAKING_ANSWER,
  ERROR_RECOVERY,
}

@Serializable
enum class AssistantRecentContextWindowHint {
  @SerialName("last_15s")
  LAST_15S,

  @SerialName("last_60s")
  LAST_60S,

  @SerialName("last_5m")
  LAST_5M,
}

@Serializable
enum class AssistantModeHint {
  @SerialName("auto")
  AUTO,

  @SerialName("meeting")
  MEETING,

  @SerialName("desk")
  DESK,
}

@Serializable
data class AssistantQueryRequest(
  val queryAudio: String,
  val fileName: String,
  @SerialName("queryMime") val queryMime: String,
  val capturedAt: Long,
  @SerialName("queryDurationMs") val queryDurationMs: Long? = null,
  @SerialName("recentContextWindowHint")
  val recentContextWindowHint: AssistantRecentContextWindowHint = AssistantRecentContextWindowHint.LAST_60S,
  @SerialName("modeHint") val modeHint: AssistantModeHint = AssistantModeHint.AUTO,
)

@Serializable
data class AssistantSupportingEvidence(
  val windowId: String,
  val timeRange: String,
  val summary: String,
  val transcriptExcerpt: String? = null,
  val artifactUrls: List<String> = emptyList(),
)

@Serializable
data class AssistantQuerySttDiagnostics(
  val provider: String? = null,
  val failureReason: String? = null,
  val rawQueryText: String? = null,
  val queryRewriteReason: String? = null,
  val queryDurationMs: Long? = null,
)

@Serializable
data class AssistantQueryResponse(
  val ok: Boolean = true,
  val queryText: String = "",
  val answerText: String,
  val answerSpokenText: String,
  val supportingEvidence: List<AssistantSupportingEvidence> = emptyList(),
  val modeUsed: AssistantModeHint = AssistantModeHint.AUTO,
  val answeredAt: Long = System.currentTimeMillis(),
  val answerSource: String? = null,
  val actionIntent: AssistantActionIntent? = null,
  val stt: AssistantQuerySttDiagnostics? = null,
)

@Serializable
data class AssistantActionIntent(
  val type: String = "none",
  val title: String? = null,
  val reason: String? = null,
  val contentHint: String? = null,
  val fileName: String? = null,
  val filePath: String? = null,
)

data class AssistantInteractionSnapshot(
  val phase: AssistantInteractionPhase = AssistantInteractionPhase.PASSIVE_SENSING,
  val lastUpdatedAt: Long = System.currentTimeMillis(),
  val mode: AssistantModeHint = AssistantModeHint.AUTO,
  val lastError: String? = null,
  val queryText: String? = null,
  val answerText: String? = null,
  val answerSpokenText: String? = null,
  val answeredAt: Long? = null,
)
