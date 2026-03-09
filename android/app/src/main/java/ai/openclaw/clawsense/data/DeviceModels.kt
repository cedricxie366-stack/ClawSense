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
  val note: String? = null,
)

data class CapturedImageFrame(
  val bytes: ByteArray,
  val mime: String = "image/jpeg",
  val fileName: String = "snapshot.jpg",
  val capturedAt: Long = System.currentTimeMillis(),
  val note: String? = null,
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
