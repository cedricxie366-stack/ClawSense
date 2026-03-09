package ai.openclaw.clawsense.data

import ai.openclaw.clawsense.BuildConfig
import android.content.Context
import android.os.Build
import android.util.Base64
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class OkHttpClawSenseApi(
  private val json: Json,
  private val context: Context,
) : ClawSenseApi {
  private val client = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .build()

  override suspend fun pair(
    host: String,
    token: String,
    deviceName: String,
    appVersion: String,
    fingerprint: String,
  ): DeviceSession = withContext(Dispatchers.IO) {
    val normalizedHost = normalizeHost(host)
    val response = request<PairingRequest, PairingResponse>(
      url = "$normalizedHost/api/clawsense/pair",
      body = PairingRequest(
        setupToken = token,
        deviceName = deviceName,
        appVersion = appVersion,
        fingerprint = fingerprint,
      ),
    )
    DeviceSession(
      host = normalizedHost,
      deviceId = response.deviceId,
      deviceSecret = response.deviceSecret,
      uploadBaseUrl = response.uploadBaseUrl.trimEnd('/'),
      heartbeatIntervalSec = response.heartbeatIntervalSec,
      memoryNamespace = response.memoryNamespace,
      pairedAt = response.pairedAt,
    )
  }

  override suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip) {
    request<AudioUploadRequest, UnitResponse>(
      url = "${session.uploadBaseUrl}/ingest/audio",
      body = AudioUploadRequest(
        audioBase64 = Base64.encodeToString(clip.bytes, Base64.NO_WRAP),
        fileName = clip.fileName,
        mime = clip.mime,
        capturedAt = clip.capturedAt,
        note = clip.note,
      ),
      bearer = session.deviceSecret,
    )
  }

  override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame) {
    request<ImageUploadRequest, UnitResponse>(
      url = "${session.uploadBaseUrl}/ingest/image",
      body = ImageUploadRequest(
        imageBase64 = Base64.encodeToString(image.bytes, Base64.NO_WRAP),
        fileName = image.fileName,
        mime = image.mime,
        capturedAt = image.capturedAt,
        note = image.note,
      ),
      bearer = session.deviceSecret,
    )
  }

  override suspend fun sendHeartbeat(session: DeviceSession, heartbeat: HeartbeatRequest): Int {
    val response = request<HeartbeatRequest, HeartbeatResponse>(
      url = "${session.uploadBaseUrl}/heartbeat",
      body = heartbeat,
      bearer = session.deviceSecret,
    )
    return response.heartbeatIntervalSec
  }

  private suspend inline fun <reified B : Any, reified T> request(
    url: String,
    body: B,
    bearer: String? = null,
  ): T = withContext(Dispatchers.IO) {
    val requestBody = json.encodeToString(body).toRequestBody(JSON_MEDIA_TYPE)
    val request = Request.Builder()
      .url(url)
      .post(requestBody)
      .header("Content-Type", "application/json")
      .header("User-Agent", buildUserAgent())
      .apply {
        if (!bearer.isNullOrBlank()) {
          header("Authorization", "Bearer $bearer")
        }
      }
      .build()

    client.newCall(request).execute().use { response ->
      val raw = response.body?.string().orEmpty()
      if (!response.isSuccessful) {
        throw IOException("HTTP ${response.code}: ${raw.ifBlank { response.message }}")
      }
      if (T::class == UnitResponse::class && raw.isBlank()) {
        @Suppress("UNCHECKED_CAST")
        return@withContext UnitResponse(true) as T
      }
      try {
        return@withContext json.decodeFromString<T>(raw)
      } catch (error: SerializationException) {
        throw IOException("响应解析失败: ${error.message}", error)
      }
    }
  }

  private fun normalizeHost(host: String): String {
    val trimmed = host.trim()
    val withProtocol = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      trimmed
    } else {
      "http://$trimmed"
    }
    return withProtocol.trimEnd('/')
  }

  private fun buildUserAgent(): String {
    return "ClawSenseAndroid/${BuildConfig.VERSION_NAME} (${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE}; ${context.packageName})"
  }

  @kotlinx.serialization.Serializable
  private data class UnitResponse(val ok: Boolean = true)

  @kotlinx.serialization.Serializable
  private data class HeartbeatResponse(
    val ok: Boolean,
    val heartbeatIntervalSec: Int = 60,
  )

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
  }
}
