package ai.openclaw.clawsense.data

import ai.openclaw.clawsense.BuildConfig
import android.content.Context
import android.os.Build
import android.util.Base64
import java.io.IOException
import java.net.URI
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
      uploadBaseUrl = resolveUploadBaseUrl(
        pairingHost = normalizedHost,
        responseUploadBaseUrl = response.uploadBaseUrl,
      ),
      heartbeatIntervalSec = response.heartbeatIntervalSec,
      memoryNamespace = response.memoryNamespace,
      pairedAt = response.pairedAt,
    )
  }

  override suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip): IngestUploadResult {
    val response = request<AudioUploadRequest, IngestUploadResponse>(
      url = "${session.uploadBaseUrl}/ingest/audio",
      body = AudioUploadRequest(
        audioBase64 = Base64.encodeToString(clip.bytes, Base64.NO_WRAP),
        fileName = clip.fileName,
        mime = clip.mime,
        capturedAt = clip.capturedAt,
        note = clip.note,
      ),
      bearer = session.deviceSecret,
      deviceId = session.deviceId,
    )
    return response.toResult()
  }

  override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame): IngestUploadResult {
    val response = request<ImageUploadRequest, IngestUploadResponse>(
      url = "${session.uploadBaseUrl}/ingest/image",
      body = ImageUploadRequest(
        imageBase64 = Base64.encodeToString(image.bytes, Base64.NO_WRAP),
        fileName = image.fileName,
        mime = image.mime,
        capturedAt = image.capturedAt,
        note = image.note,
      ),
      bearer = session.deviceSecret,
      deviceId = session.deviceId,
    )
    return response.toResult()
  }

  override suspend fun uploadVideo(session: DeviceSession, clip: CapturedVideoClip): IngestUploadResult {
    val response = request<VideoUploadRequest, IngestUploadResponse>(
      url = "${session.uploadBaseUrl}/ingest/video",
      body = VideoUploadRequest(
        videoBase64 = Base64.encodeToString(clip.bytes, Base64.NO_WRAP),
        fileName = clip.fileName,
        mime = clip.mime,
        capturedAt = clip.capturedAt,
        note = clip.note,
        keyframes = clip.keyframes.map { keyframe ->
          VideoUploadKeyframeRequest(
            imageBase64 = Base64.encodeToString(keyframe.image.bytes, Base64.NO_WRAP),
            fileName = keyframe.image.fileName,
            mime = keyframe.image.mime,
            capturedAt = keyframe.image.capturedAt,
            note = keyframe.image.note,
            videoOffsetMs = keyframe.videoOffsetMs,
          )
        },
      ),
      bearer = session.deviceSecret,
      deviceId = session.deviceId,
    )
    return response.toResult()
  }

  override suspend fun queryAssistant(
    session: DeviceSession,
    request: AssistantQueryRequest,
  ): AssistantQueryResponse {
    return request<AssistantQueryRequest, AssistantQueryResponse>(
      url = "${session.uploadBaseUrl}/assistant/query",
      body = request,
      bearer = session.deviceSecret,
      deviceId = session.deviceId,
    )
  }

  override suspend fun sendHeartbeat(session: DeviceSession, heartbeat: HeartbeatRequest): HeartbeatResult {
    val response = request<HeartbeatRequest, HeartbeatResponse>(
      url = "${session.uploadBaseUrl}/heartbeat",
      body = heartbeat,
      bearer = session.deviceSecret,
      deviceId = session.deviceId,
    )
    return HeartbeatResult(
      heartbeatIntervalSec = response.heartbeatIntervalSec,
      captureDirective = response.captureDirective,
    )
  }

  private suspend inline fun <reified B : Any, reified T> request(
    url: String,
    body: B,
    bearer: String? = null,
    deviceId: String? = null,
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
        if (!deviceId.isNullOrBlank()) {
          header("X-ClawSense-Device-Id", deviceId)
        }
      }
      .build()

    client.newCall(request).execute().use { response ->
      val raw = response.body?.string().orEmpty()
      if (!response.isSuccessful) {
        val message = "HTTP ${response.code}: ${raw.ifBlank { response.message }}"
        if (response.code == 401) {
          val apiError = decodeApiError(raw)
          val reason = apiError?.reason?.takeIf { it.isNotBlank() } ?: "unauthorized"
          val hint = apiError?.hint?.takeIf { it.isNotBlank() }
          val normalizedMessage = buildString {
            append(message)
            append(" (reason=")
            append(reason)
            append(")")
            if (!hint.isNullOrBlank()) {
              append(" ")
              append(hint)
            }
          }
          throw ClawSenseAuthException(normalizedMessage)
        }
        if (response.code == 503) {
          val apiError = decodeApiError(raw)
          if (apiError?.error == "ingest_queue_full") {
            throw ClawSenseBackpressureException(
              message = message,
              retryAfterSec = apiError.retryAfterSec ?: parseRetryAfterSeconds(response.header("Retry-After")),
              queueDepth = apiError.queueDepth,
            )
          }
        }
        throw IOException(message)
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

  private fun resolveUploadBaseUrl(pairingHost: String, responseUploadBaseUrl: String): String {
    val normalizedPairingUploadBase = "${pairingHost.trimEnd('/')}/api/clawsense"
    val normalizedResponse = responseUploadBaseUrl.trim().trimEnd('/')
    if (normalizedResponse.isBlank()) {
      return normalizedPairingUploadBase
    }
    val pairingHostName = normalizedUrlHost(pairingHost)
    val responseHostName = normalizedUrlHost(normalizedResponse)
    if (isLoopbackHost(pairingHostName) || isNonRoutableHost(responseHostName)) {
      return normalizedPairingUploadBase
    }
    return normalizedResponse
  }

  private fun normalizedUrlHost(url: String): String? {
    return runCatching { URI(url).host?.trim()?.lowercase() }.getOrNull()
  }

  private fun isLoopbackHost(host: String?): Boolean {
    return host == "127.0.0.1" || host == "::1" || host == "localhost"
  }

  private fun isNonRoutableHost(host: String?): Boolean {
    return host == null || host == "lan" || host == "0.0.0.0" || host == "::" || host == "*"
  }

  private fun buildUserAgent(): String {
    return "ClawSenseAndroid/${BuildConfig.VERSION_NAME} (${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE}; ${context.packageName})"
  }

  @kotlinx.serialization.Serializable
  private data class UnitResponse(val ok: Boolean = true)

  @kotlinx.serialization.Serializable
  private data class IngestUploadResponse(
    val ok: Boolean = true,
    val stored: Boolean = true,
    val analysisQueued: Boolean? = null,
    val queueDepth: Int? = null,
    val analysisQueueDepth: Int? = null,
  ) {
    fun toResult(): IngestUploadResult {
      return IngestUploadResult(
        stored = stored,
        analysisQueued = analysisQueued,
        queueDepth = queueDepth,
        analysisQueueDepth = analysisQueueDepth,
      )
    }
  }

  @kotlinx.serialization.Serializable
  private data class HeartbeatResponse(
    val ok: Boolean,
    val heartbeatIntervalSec: Int = 60,
    val captureDirective: CaptureVideoDirective? = null,
  )

  @kotlinx.serialization.Serializable
  private data class ErrorResponse(
    val ok: Boolean? = null,
    val error: String? = null,
    val reason: String? = null,
    val hint: String? = null,
    val rePairRequired: Boolean? = null,
    val queueDepth: Int? = null,
    val retryAfterSec: Int? = null,
  )

  private fun decodeApiError(raw: String): ErrorResponse? {
    if (raw.isBlank()) {
      return null
    }
    return runCatching { json.decodeFromString<ErrorResponse>(raw) }.getOrNull()
  }

  private fun parseRetryAfterSeconds(value: String?): Int? {
    val parsed = value?.trim()?.toIntOrNull() ?: return null
    return parsed.coerceIn(1, 60)
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
  }
}

class ClawSenseAuthException(
  message: String,
) : IOException(message)

class ClawSenseBackpressureException(
  message: String,
  val retryAfterSec: Int?,
  val queueDepth: Int?,
) : IOException(message)
