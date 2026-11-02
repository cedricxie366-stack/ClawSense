package ai.openclaw.clawsense.data

import ai.openclaw.clawsense.BuildConfig
import android.os.Build
import java.io.IOException
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class DeviceSessionRepository(
  private val store: DeviceSessionPersistence,
  private val api: ClawSenseApi,
  private val pendingUploads: PendingUploadSpool,
) {
  private val _session = MutableStateFlow(store.loadSession())
  private val _serviceEnabled = MutableStateFlow(store.loadServiceEnabled())
  private val _runtimeStatus = MutableStateFlow(store.loadRuntimeStatus())
  private val _capturePreferences = MutableStateFlow(store.loadCapturePreferences())
  private val _activitySnapshot = MutableStateFlow(ServiceActivitySnapshot())
  private val _assistantSnapshot = MutableStateFlow(AssistantInteractionSnapshot())
  private val uploadMutex = Mutex()
  private val storageLock = Any()
  private var pendingUploadWarning: String? = null
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
      if (!BuildConfig.DEBUG || !pairingSetup.host.isLoopbackHost()) {
        throw IllegalArgumentException(warning)
      }
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
    synchronized(storageLock) { store.saveSession(session); _session.value = session }
    return session
  }

  fun refresh() = synchronized(storageLock) {
    _session.value = store.loadSession()
    _serviceEnabled.value = store.loadServiceEnabled()
    _runtimeStatus.value = store.loadRuntimeStatus()
    _capturePreferences.value = store.loadCapturePreferences()
  }

  fun requireSession(): DeviceSession {
    return _session.value ?: throw IllegalStateException("设备尚未配对")
  }

  fun clearSession() = synchronized(storageLock) {
    store.clearSession()
    store.saveServiceEnabled(false)
    updateRuntimeStatus(ServiceRuntimeStatus())
    val spoolError = clearPendingUploads()
    pendingUploadWarning = null
    backpressureUntilMs = 0L
    debugThrottleUntilMs = 0L
    debugThrottleDepth = null
    _activitySnapshot.value = ServiceActivitySnapshot(lastError = spoolError, lastErrorAt = spoolError?.let { System.currentTimeMillis() })
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
    val lossWarning = pendingUploadWarning
    _activitySnapshot.value = _activitySnapshot.value.copy(
      lastError = if (lossWarning != null && !message.contains(lossWarning)) "$message $lossWarning" else message,
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
    val session = requireSession()
    // Backpressure must not make saving a new capture depend on the network lock.
    withContext(NonCancellable + Dispatchers.IO) {
      synchronized(storageLock) {
        if (!isCurrentSession(session)) throw CancellationException("配对已变更，停止旧录音缓存")
        val restored = restorePendingUploadsLocked(session)
        val overflow = enqueueLocked(PendingUpload.Audio(clip))
        recordError(listOfNotNull(restored, overflow, reason).joinToString(" "))
      }
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
      val response = api.queryAssistant(
        session = session,
        request = AssistantQueryRequest(
          queryAudio = java.util.Base64.getEncoder().encodeToString(clip.bytes),
          fileName = clip.fileName,
          queryMime = clip.mime,
          capturedAt = clip.capturedAt,
          queryDurationMs = clip.durationMs,
          recentContextWindowHint = windowHint,
          modeHint = modeHint,
        ),
      )
      if (!isCurrentSession(session)) throw CancellationException("配对已变更，忽略旧会话回答")
      response.contextSnapshotId?.let { snapshotId ->
        val validation = api.validateCachedContext(session, snapshotId)
        if (validation?.state != "current") throw IllegalStateException("回答来源已失效或尚无法确认，请重新提问。")
      }
      if (!isCurrentSession(session)) throw CancellationException("配对已变更，忽略旧来源验证结果")
      response
    } catch (error: Throwable) {
      if (error is CancellationException) {
        throw error
      }
      if (error is ClawSenseAuthException) {
        if (!invalidateSession("设备凭证已失效（401 unauthorized），请重新配对。", expectedSession = session)) throw CancellationException("配对已变更，忽略旧连接认证错误")
      }
      throw error
    }
  }

  suspend fun sendHeartbeat(heartbeat: HeartbeatRequest): HeartbeatResult {
    val session = requireSession()
    return try {
      val result = api.sendHeartbeat(session, heartbeat.copy(cacheSnapshotId = _assistantSnapshot.value.contextSnapshotId))
      if (!isCurrentSession(session)) throw CancellationException("配对已变更，忽略旧连接心跳")
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
        if (!invalidateSession("设备凭证已失效（401 unauthorized），请重新配对。", expectedSession = session)) throw CancellationException("配对已变更，忽略旧连接认证错误")
        throw error
      }
      recordError("心跳失败：${error.message ?: "未知错误"}")
      throw error
    }
  }

  private suspend fun submitUpload(upload: PendingUpload) {
    val session = requireSession()
    var failure: Throwable? = null
    // Persist independently of a stalled network request. Once accepted here,
    // stopping its caller must not discard a capture waiting for uploadMutex.
    val warning = withContext(NonCancellable + Dispatchers.IO) {
      synchronized(storageLock) {
        if (!isCurrentSession(session)) throw CancellationException("配对已变更，停止旧素材上传")
        val restored = restorePendingUploadsLocked(session)
        val overflow = enqueueLocked(upload)
        listOfNotNull(restored, overflow).joinToString(" ")
      }
    }

    uploadMutex.withLock {
      withContext(Dispatchers.IO) {
        if (!isCurrentSession(session)) throw CancellationException("配对已变更，停止旧连接")
        failure = runCatching { flushPendingUploadsLocked(session) }.exceptionOrNull()
        synchronized(storageLock) {
          if (!isCurrentSession(session)) throw CancellationException("配对已变更，忽略旧连接结果")
          val error = failure
          if (error != null) {
            if (error is CancellationException) throw error
            if (error is ClawSenseAuthException) {
              invalidateSessionLocked("设备凭证已失效（401 unauthorized），请重新配对。")
            } else if (error is ClawSenseBackpressureException) {
              applyBackpressureLocked(error)
              recordError("$warning ${upload.label}尚未上传，已保存在本地补传队列，稍后重试。".trim())
              failure = null
            } else {
              recordError("$warning ${upload.label}尚未确认上传，本地补传记录已保留：${error.message ?: "未知错误"}".trim())
            }
          } else if (warning.isNotBlank()) {
            recordError(warning)
          }
        }
      }
    }

    failure?.let { throw it }
  }

  private suspend fun retryPendingUploads(session: DeviceSession) {
    uploadMutex.withLock {
      withContext(Dispatchers.IO) {
        val warning = synchronized(storageLock) {
          if (!isCurrentSession(session)) return@withContext
          restorePendingUploadsLocked(session)
        }
        try {
          flushPendingUploadsLocked(session)
        } finally {
          if (warning != null) recordError(warning)
        }
      }
    }
  }

  private suspend fun flushPendingUploadsLocked(session: DeviceSession) {
    if (System.currentTimeMillis() < backpressureUntilMs) {
      return
    }
    while (true) {
      val entry = synchronized(storageLock) {
        if (!isCurrentSession(session)) return
        pendingUploads.firstOrNull(session)
      } ?: break
      val pending = entry.upload
      try {
        val result = performUpload(session, pending)
        synchronized(storageLock) {
          if (!isCurrentSession(session)) return
          if (!pendingUploads.acknowledge(entry.id, result.stored)) throw IOException("Host 未确认 stored=true，等待补传。")
          markUploadSuccess(pending, result)
        }
      } catch (error: Throwable) {
        if (error is CancellationException) {
          throw error
        }
        if (!isCurrentSession(session)) throw CancellationException("配对已变更，忽略旧连接错误")
        if (error is ClawSenseDeletedCaptureException) {
          synchronized(storageLock) { if (isCurrentSession(session)) pendingUploads.acknowledge(entry.id, true) }
          recordError("服务端已删除${pending.label}，对应本机补传副本已清除。")
          continue
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

  private fun isCurrentSession(expected: DeviceSession): Boolean {
    val current = _session.value ?: return false
    return current.host == expected.host && current.deviceId == expected.deviceId && current.deviceSecret == expected.deviceSecret
  }

  private fun enqueueLocked(upload: PendingUpload): String? {
    val result = try {
      pendingUploads.enqueue(upload)
    } catch (error: Exception) {
      recordError("${upload.label}未上传：无法写入本地补传缓存（请检查存储空间）：${error.message ?: "未知错误"}")
      throw error
    }
    if (!result.accepted) {
      val message = "${upload.label}未上传且未加入补传队列：单条素材超过本地缓存上限。"
      recordError(message)
      throw IOException(message)
    }
    _activitySnapshot.value = _activitySnapshot.value.copy(pendingUploads = pendingUploads.size)
    val warning = if (result.discarded > 0) "本地补传队列达到 6 条或 64MiB 上限，已丢弃最旧的 ${result.discarded} 条未上传素材。" else null
    if (warning != null) pendingUploadWarning = warning
    return warning
  }

  private fun restorePendingUploadsLocked(session: DeviceSession): String? {
    val restored = try {
      pendingUploads.restore(session)
    } catch (error: Exception) {
      recordError("本地补传缓存无法读取，尚未上传：${error.message ?: "未知错误"}")
      throw error
    }
    _activitySnapshot.value = _activitySnapshot.value.copy(pendingUploads = pendingUploads.size)
    val discarded = restored.discarded + restored.incomplete
    val warning = if (discarded > 0) "恢复补传队列时已丢弃 $discarded 条损坏、未完成、超限或属于旧配对的缓存。" else null
    if (warning != null) pendingUploadWarning = warning
    return warning
  }

  private fun clearPendingUploads(): String? = try {
    pendingUploads.clear()
    null
  } catch (error: Exception) {
    "本地补传缓存未能完全清除：${error.message ?: "未知错误"}"
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

  private fun invalidateSession(message: String, occurredAt: Long = System.currentTimeMillis(), expectedSession: DeviceSession? = null): Boolean = synchronized(storageLock) {
    if (expectedSession != null && !isCurrentSession(expectedSession)) return@synchronized false
    invalidateSessionLocked(message, occurredAt)
    true
  }

  private fun invalidateSessionLocked(message: String, occurredAt: Long = System.currentTimeMillis()) {
    val spoolError = clearPendingUploads()
    backpressureUntilMs = 0L
    debugThrottleUntilMs = 0L
    debugThrottleDepth = null
    _activitySnapshot.value = _activitySnapshot.value.copy(
      pendingUploads = 0,
      lastError = listOfNotNull(message, spoolError).joinToString(" "),
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

  private fun String.isLoopbackHost(): Boolean {
    val host = runCatching { URI(this).host?.trim()?.lowercase() }.getOrNull()
    return host == "127.0.0.1" || host == "::1" || host == "localhost"
  }

  private fun applyBackpressureLocked(error: ClawSenseBackpressureException) {
    val retryAfterSec = (error.retryAfterSec ?: DEFAULT_BACKPRESSURE_RETRY_SEC).coerceIn(1, 60)
    val candidate = System.currentTimeMillis() + retryAfterSec * 1_000L
    if (candidate > backpressureUntilMs) {
      backpressureUntilMs = candidate
    }
  }

  private companion object {
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
