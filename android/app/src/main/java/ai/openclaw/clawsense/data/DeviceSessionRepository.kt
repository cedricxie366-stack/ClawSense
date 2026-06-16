package ai.openclaw.clawsense.data

import android.os.Build
import java.util.ArrayDeque
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class DeviceSessionRepository(
  private val store: SecureSessionStore,
  private val api: ClawSenseApi,
) {
  private val _session = MutableStateFlow(store.loadSession())
  private val _serviceEnabled = MutableStateFlow(store.loadServiceEnabled())
  private val _runtimeStatus = MutableStateFlow(store.loadRuntimeStatus())
  private val _capturePreferences = MutableStateFlow(store.loadCapturePreferences())
  private val _activitySnapshot = MutableStateFlow(ServiceActivitySnapshot())
  private val _assistantSnapshot = MutableStateFlow(AssistantInteractionSnapshot())
  private val uploadMutex = Mutex()
  private val pendingUploads = ArrayDeque<PendingUpload>()
  private var backpressureUntilMs: Long = 0L
  private var debugThrottleUntilMs: Long = 0L
  private var debugThrottleDepth: Int? = null

  val session: StateFlow<DeviceSession?> = _session.asStateFlow()
  val serviceEnabled: StateFlow<Boolean> = _serviceEnabled.asStateFlow()
  val runtimeStatus: StateFlow<ServiceRuntimeStatus> = _runtimeStatus.asStateFlow()
  val capturePreferences: StateFlow<CapturePreferences> = _capturePreferences.asStateFlow()
  val activitySnapshot: StateFlow<ServiceActivitySnapshot> = _activitySnapshot.asStateFlow()
  val assistantSnapshot: StateFlow<AssistantInteractionSnapshot> = _assistantSnapshot.asStateFlow()

  suspend fun pairWithSetupCode(
    setupCode: String,
    deviceName: String,
    appVersion: String,
  ): DeviceSession {
    val pairingSetup = SetupCodeParser.parse(setupCode)
      ?: throw IllegalArgumentException("二维码/引导码无法解析，请重新扫码。")
    pairingSetup.warning?.let { warning ->
      throw IllegalArgumentException(warning)
    }
    return pairManual(
      host = pairingSetup.host,
      token = pairingSetup.token,
      deviceName = deviceName,
      appVersion = appVersion,
    )
  }

  suspend fun pairManual(
    host: String,
    token: String,
    deviceName: String,
    appVersion: String,
  ): DeviceSession {
    val session = api.pair(
      host = host,
      token = token,
      deviceName = deviceName,
      appVersion = appVersion,
      fingerprint = buildFingerprint(),
    )
    store.saveSession(session)
    _session.value = session
    return session
  }

  fun refresh() {
    _session.value = store.loadSession()
    _serviceEnabled.value = store.loadServiceEnabled()
    _runtimeStatus.value = store.loadRuntimeStatus()
    _capturePreferences.value = store.loadCapturePreferences()
  }

  fun requireSession(): DeviceSession {
    return _session.value ?: throw IllegalStateException("设备尚未配对")
  }

  fun clearSession() {
    store.clearSession()
    store.saveServiceEnabled(false)
    updateRuntimeStatus(ServiceRuntimeStatus())
    pendingUploads.clear()
    backpressureUntilMs = 0L
    debugThrottleUntilMs = 0L
    debugThrottleDepth = null
    _activitySnapshot.value = ServiceActivitySnapshot()
    _assistantSnapshot.value = AssistantInteractionSnapshot()
    _session.value = null
    _serviceEnabled.value = false
  }

  fun setServiceEnabled(enabled: Boolean) {
    store.saveServiceEnabled(enabled)
    _serviceEnabled.value = enabled
  }

  fun updateRuntimeStatus(status: ServiceRuntimeStatus) {
    store.saveRuntimeStatus(status)
    _runtimeStatus.value = status
  }

  fun setAutoVideoEnabled(enabled: Boolean) {
    val next = _capturePreferences.value.copy(autoVideoEnabled = enabled)
    store.saveCapturePreferences(next)
    _capturePreferences.value = next
  }

  fun recordError(message: String, occurredAt: Long = System.currentTimeMillis()) {
    _activitySnapshot.value = _activitySnapshot.value.copy(
      lastError = message,
      lastErrorAt = occurredAt,
      pendingUploads = pendingUploads.size,
    )
  }

  fun updateVideoCaptureStatus(
    message: String?,
    inProgress: Boolean,
    occurredAt: Long = System.currentTimeMillis(),
  ) {
    _activitySnapshot.value = _activitySnapshot.value.copy(
      videoCaptureInProgress = inProgress,
      lastVideoStatus = message,
      lastVideoStatusAt = occurredAt,
      pendingUploads = pendingUploads.size,
    )
  }

  fun updateAssistantSnapshot(snapshot: AssistantInteractionSnapshot) {
    _assistantSnapshot.value = snapshot
  }

  fun captureThrottleSnapshot(nowMs: Long = System.currentTimeMillis()): CaptureThrottleSnapshot {
    val activity = _activitySnapshot.value
    val backpressureRemainingMs = (backpressureUntilMs - nowMs).coerceAtLeast(0L)
    val debugThrottleRemainingMs = (debugThrottleUntilMs - nowMs).coerceAtLeast(0L)
    val lastUploadAt = listOfNotNull(
      activity.lastAudioUploadAt,
      activity.lastImageUploadAt,
      activity.lastVideoUploadAt,
    ).maxOrNull()
    val queueSignalFresh = lastUploadAt != null && nowMs - lastUploadAt <= QUEUE_SIGNAL_TTL_MS
    val analysisQueueDepth = if (debugThrottleRemainingMs > 0L) {
      debugThrottleDepth ?: ANALYSIS_SEVERE_DEPTH
    } else {
      activity.lastServerQueueDepth
    }
    val analysisRejected = debugThrottleRemainingMs > 0L || (queueSignalFresh && activity.lastAnalysisQueued == false)
    val pendingUploadCount = pendingUploads.size
    val severeQueueDepth = queueSignalFresh && analysisQueueDepth != null && analysisQueueDepth >= ANALYSIS_SEVERE_DEPTH
    val elevatedQueueDepth = queueSignalFresh && analysisQueueDepth != null && analysisQueueDepth >= ANALYSIS_ELEVATED_DEPTH
    val pendingUploadPressure = pendingUploadCount >= PENDING_UPLOAD_PRESSURE_THRESHOLD

    val level = when {
      debugThrottleRemainingMs > 0L || backpressureRemainingMs > 0L || analysisRejected || severeQueueDepth ->
        CaptureThrottleLevel.SEVERE
      elevatedQueueDepth || pendingUploadPressure -> CaptureThrottleLevel.ELEVATED
      else -> CaptureThrottleLevel.NORMAL
    }
    val reason = when {
      debugThrottleRemainingMs > 0L -> "debug_validation_throttle"
      backpressureRemainingMs > 0L -> "server_backpressure"
      analysisRejected -> "analysis_not_queued"
      severeQueueDepth -> "analysis_queue_severe"
      elevatedQueueDepth -> "analysis_queue_elevated"
      pendingUploadPressure -> "pending_upload_pressure"
      else -> null
    }

    return CaptureThrottleSnapshot(
      level = level,
      reason = reason,
      backpressureUntilMs = backpressureUntilMs.takeIf { backpressureRemainingMs > 0L },
      pendingUploads = pendingUploadCount,
      analysisQueueDepth = analysisQueueDepth,
      deferLowSignalAudio = level == CaptureThrottleLevel.SEVERE,
      pauseAutoVideo = level != CaptureThrottleLevel.NORMAL,
      stillIntervalMultiplier = when (level) {
        CaptureThrottleLevel.NORMAL -> 1
        CaptureThrottleLevel.ELEVATED -> 3
        CaptureThrottleLevel.SEVERE -> 6
      },
      skipImmediateStillCapture = level == CaptureThrottleLevel.SEVERE,
    )
  }

  suspend fun deferAudioUpload(clip: CapturedAudioClip, reason: String) {
    uploadMutex.withLock {
      enqueueLocked(PendingUpload.Audio(clip))
      recordError(reason)
    }
  }

  fun injectDebugCaptureThrottle(durationMs: Long, queueDepth: Int = ANALYSIS_SEVERE_DEPTH) {
    val now = System.currentTimeMillis()
    debugThrottleUntilMs = now + durationMs.coerceIn(1_000L, DEBUG_THROTTLE_MAX_MS)
    debugThrottleDepth = queueDepth.coerceAtLeast(0)
    _activitySnapshot.value = _activitySnapshot.value.copy(
      lastUploadStored = true,
      lastAnalysisQueued = false,
      lastServerQueueDepth = debugThrottleDepth,
      lastError = "Debug throttle injected for validation (${durationMs}ms).",
      lastErrorAt = now,
    )
  }

  suspend fun uploadAudio(clip: CapturedAudioClip) {
    submitUpload(PendingUpload.Audio(clip))
  }

  suspend fun uploadImage(image: CapturedImageFrame) {
    submitUpload(PendingUpload.Image(image))
  }

  suspend fun uploadVideo(clip: CapturedVideoClip) {
    submitUpload(PendingUpload.Video(clip))
  }

  suspend fun queryAssistant(
    clip: CapturedAudioClip,
    windowHint: AssistantRecentContextWindowHint = AssistantRecentContextWindowHint.LAST_60S,
    modeHint: AssistantModeHint = AssistantModeHint.AUTO,
  ): AssistantQueryResponse {
    val session = requireSession()
    return try {
      api.queryAssistant(
        session = session,
        request = AssistantQueryRequest(
          queryAudio = android.util.Base64.encodeToString(clip.bytes, android.util.Base64.NO_WRAP),
          fileName = clip.fileName,
          queryMime = clip.mime,
          capturedAt = clip.capturedAt,
          queryDurationMs = clip.durationMs,
          recentContextWindowHint = windowHint,
          modeHint = modeHint,
        ),
      )
    } catch (error: Throwable) {
      if (error is CancellationException) {
        throw error
      }
      if (error is ClawSenseAuthException) {
        invalidateSession("设备凭证已失效（401 unauthorized），请重新配对。")
      }
      throw error
    }
  }

  suspend fun sendHeartbeat(heartbeat: HeartbeatRequest): HeartbeatResult {
    val session = requireSession()
    return try {
      val result = api.sendHeartbeat(session, heartbeat)
      runCatching { retryPendingUploads(session) }
        .onFailure { error ->
          if (error is CancellationException) {
            throw error
          }
          recordError("网络已恢复，但补传仍失败：${error.message ?: "未知错误"}")
        }
      result
    } catch (error: Throwable) {
      if (error is CancellationException) {
        throw error
      }
      if (error is ClawSenseAuthException) {
        invalidateSession("设备凭证已失效（401 unauthorized），请重新配对。")
        throw error
      }
      recordError("心跳失败：${error.message ?: "未知错误"}")
      throw error
    }
  }

  private suspend fun submitUpload(upload: PendingUpload) {
    val session = requireSession()
    var failure: Throwable? = null

    uploadMutex.withLock {
      failure = runCatching {
        flushPendingUploadsLocked(session)
        val result = performUpload(session, upload)
        markUploadSuccess(upload, result)
      }.exceptionOrNull()

      val error = failure
      if (error != null) {
        if (error is CancellationException) {
          throw error
        }
        if (error is ClawSenseAuthException) {
          invalidateSessionLocked("设备凭证已失效（401 unauthorized），请重新配对。")
          recordError("${upload.label}上传失败：设备凭证已失效，请重新配对。")
        } else if (error is ClawSenseBackpressureException) {
          applyBackpressureLocked(error)
          enqueueLocked(upload)
          val waitSec = error.retryAfterSec ?: DEFAULT_BACKPRESSURE_RETRY_SEC
          val queueInfo = error.queueDepth?.let { "（服务端队列深度 $it）" } ?: ""
          recordError("${upload.label}上传遇到拥堵，已加入补传队列${queueInfo}，预计 ${waitSec}s 后重试。")
          failure = null
        } else {
          enqueueLocked(upload)
          recordError("${upload.label}上传失败，已加入重试队列：${error.message ?: "未知错误"}")
        }
      }
    }

    failure?.let { throw it }
  }

  private suspend fun retryPendingUploads(session: DeviceSession) {
    uploadMutex.withLock {
      flushPendingUploadsLocked(session)
    }
  }

  private suspend fun flushPendingUploadsLocked(session: DeviceSession) {
    if (System.currentTimeMillis() < backpressureUntilMs) {
      return
    }
    while (pendingUploads.isNotEmpty()) {
      val pending = pendingUploads.first()
      try {
        val result = performUpload(session, pending)
        pendingUploads.removeFirst()
        markUploadSuccess(pending, result)
      } catch (error: Throwable) {
        if (error is CancellationException) {
          throw error
        }
        if (error is ClawSenseBackpressureException) {
          applyBackpressureLocked(error)
          val waitSec = error.retryAfterSec ?: DEFAULT_BACKPRESSURE_RETRY_SEC
          recordError("服务端仍在拥堵，暂停补传 ${waitSec}s 后再试。")
          return
        }
        recordError("重试${pending.label}失败：${error.message ?: "未知错误"}")
        throw error
      }
    }
  }

  private suspend fun performUpload(session: DeviceSession, upload: PendingUpload): IngestUploadResult {
    return when (upload) {
      is PendingUpload.Audio -> api.uploadAudio(session, upload.clip)
      is PendingUpload.Image -> api.uploadImage(session, upload.image)
      is PendingUpload.Video -> api.uploadVideo(session, upload.clip)
    }
  }

  private fun enqueueLocked(upload: PendingUpload) {
    if (pendingUploads.size >= MAX_PENDING_UPLOADS) {
      pendingUploads.removeFirst()
      recordError("待补传队列已满，已丢弃最旧的一条上传。")
    }
    pendingUploads.addLast(upload)
    _activitySnapshot.value = _activitySnapshot.value.copy(pendingUploads = pendingUploads.size)
  }

  private fun markUploadSuccess(
    upload: PendingUpload,
    result: IngestUploadResult,
    uploadedAt: Long = System.currentTimeMillis(),
  ) {
    _activitySnapshot.value = when (upload) {
      is PendingUpload.Audio -> _activitySnapshot.value.copy(
        lastAudioUploadAt = uploadedAt,
        pendingUploads = pendingUploads.size,
        lastUploadStored = result.stored,
        lastAnalysisQueued = result.analysisQueued,
        lastServerQueueDepth = result.analysisQueueDepth ?: result.queueDepth,
      )
      is PendingUpload.Image -> _activitySnapshot.value.copy(
        lastImageUploadAt = uploadedAt,
        pendingUploads = pendingUploads.size,
        lastUploadStored = result.stored,
        lastAnalysisQueued = result.analysisQueued,
        lastServerQueueDepth = result.analysisQueueDepth ?: result.queueDepth,
      )
      is PendingUpload.Video -> _activitySnapshot.value.copy(
        lastVideoUploadAt = uploadedAt,
        videoCaptureInProgress = false,
        lastVideoStatus = "视频片段已上传。",
        lastVideoStatusAt = uploadedAt,
        pendingUploads = pendingUploads.size,
        lastUploadStored = result.stored,
        lastAnalysisQueued = result.analysisQueued,
        lastServerQueueDepth = result.analysisQueueDepth ?: result.queueDepth,
      )
    }
  }

  private fun invalidateSession(message: String, occurredAt: Long = System.currentTimeMillis()) {
    uploadMutex.tryLock().let { locked ->
      try {
        if (locked) {
          invalidateSessionLocked(message, occurredAt)
        } else {
          pendingUploads.clear()
          backpressureUntilMs = 0L
          debugThrottleUntilMs = 0L
          debugThrottleDepth = null
          _activitySnapshot.value = _activitySnapshot.value.copy(
            pendingUploads = 0,
            lastError = message,
            lastErrorAt = occurredAt,
          )
          _assistantSnapshot.value = AssistantInteractionSnapshot(
            phase = AssistantInteractionPhase.ERROR_RECOVERY,
            lastUpdatedAt = occurredAt,
            lastError = message,
          )
          store.saveServiceEnabled(false)
          _serviceEnabled.value = false
          store.saveRuntimeStatus(
            ServiceRuntimeStatus(
              phase = ServicePhase.ERROR,
              mode = CaptureMode.NONE,
              lastError = message,
              updatedAt = occurredAt,
            ),
          )
          _runtimeStatus.value = ServiceRuntimeStatus(
            phase = ServicePhase.ERROR,
            mode = CaptureMode.NONE,
            lastError = message,
            updatedAt = occurredAt,
          )
        }
      } finally {
        if (locked) {
          uploadMutex.unlock()
        }
      }
    }
  }

  private fun invalidateSessionLocked(message: String, occurredAt: Long = System.currentTimeMillis()) {
    pendingUploads.clear()
    backpressureUntilMs = 0L
    debugThrottleUntilMs = 0L
    debugThrottleDepth = null
    _activitySnapshot.value = _activitySnapshot.value.copy(
      pendingUploads = 0,
      lastError = message,
      lastErrorAt = occurredAt,
    )
    _assistantSnapshot.value = AssistantInteractionSnapshot(
      phase = AssistantInteractionPhase.ERROR_RECOVERY,
      lastUpdatedAt = occurredAt,
      lastError = message,
    )
    store.saveServiceEnabled(false)
    _serviceEnabled.value = false
    val status = ServiceRuntimeStatus(
      phase = ServicePhase.ERROR,
      mode = CaptureMode.NONE,
      lastError = message,
      updatedAt = occurredAt,
    )
    store.saveRuntimeStatus(status)
    _runtimeStatus.value = status
  }

  private fun buildFingerprint(): String {
    return listOf(Build.BRAND, Build.MODEL, Build.DEVICE, Build.VERSION.SDK_INT.toString())
      .joinToString(":")
  }

  private fun applyBackpressureLocked(error: ClawSenseBackpressureException) {
    val retryAfterSec = (error.retryAfterSec ?: DEFAULT_BACKPRESSURE_RETRY_SEC).coerceIn(1, 60)
    val candidate = System.currentTimeMillis() + retryAfterSec * 1_000L
    if (candidate > backpressureUntilMs) {
      backpressureUntilMs = candidate
    }
  }

  private sealed interface PendingUpload {
    val label: String

    data class Audio(val clip: CapturedAudioClip) : PendingUpload {
      override val label: String = "音频"
    }

    data class Image(val image: CapturedImageFrame) : PendingUpload {
      override val label: String = "图片"
    }

    data class Video(val clip: CapturedVideoClip) : PendingUpload {
      override val label: String = "视频"
    }
  }

  private companion object {
    const val MAX_PENDING_UPLOADS = 6
    const val DEFAULT_BACKPRESSURE_RETRY_SEC = 3
    const val ANALYSIS_ELEVATED_DEPTH = 12
    const val ANALYSIS_SEVERE_DEPTH = 18
    const val PENDING_UPLOAD_PRESSURE_THRESHOLD = 3
    const val QUEUE_SIGNAL_TTL_MS = 2 * 60 * 1000L
    const val DEBUG_THROTTLE_MAX_MS = 2 * 60 * 1000L
  }
}

enum class CaptureThrottleLevel {
  NORMAL,
  ELEVATED,
  SEVERE,
}

data class CaptureThrottleSnapshot(
  val level: CaptureThrottleLevel = CaptureThrottleLevel.NORMAL,
  val reason: String? = null,
  val backpressureUntilMs: Long? = null,
  val pendingUploads: Int = 0,
  val analysisQueueDepth: Int? = null,
  val deferLowSignalAudio: Boolean = false,
  val pauseAutoVideo: Boolean = false,
  val stillIntervalMultiplier: Int = 1,
  val skipImmediateStillCapture: Boolean = false,
)

data class ServiceActivitySnapshot(
  val lastAudioUploadAt: Long? = null,
  val lastImageUploadAt: Long? = null,
  val lastVideoUploadAt: Long? = null,
  val lastUploadStored: Boolean? = null,
  val lastAnalysisQueued: Boolean? = null,
  val lastServerQueueDepth: Int? = null,
  val videoCaptureInProgress: Boolean = false,
  val lastVideoStatus: String? = null,
  val lastVideoStatusAt: Long? = null,
  val lastError: String? = null,
  val lastErrorAt: Long? = null,
  val pendingUploads: Int = 0,
)
