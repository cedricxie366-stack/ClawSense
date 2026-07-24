package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.BuildConfig
import ai.openclaw.clawsense.MainActivity
import ai.openclaw.clawsense.R
import ai.openclaw.clawsense.data.AssistantInteractionPhase
import ai.openclaw.clawsense.data.AssistantInteractionSnapshot
import ai.openclaw.clawsense.data.AssistantModeHint
import ai.openclaw.clawsense.data.AssistantQueryResponse
import ai.openclaw.clawsense.data.AssistantRecentContextWindowHint
import ai.openclaw.clawsense.data.CaptureMode
import ai.openclaw.clawsense.data.CaptureVideoDirective
import ai.openclaw.clawsense.data.CapturedAudioClip
import ai.openclaw.clawsense.data.ClawSenseAuthException
import ai.openclaw.clawsense.data.DeviceSessionRepository
import ai.openclaw.clawsense.data.ServicePhase
import ai.openclaw.clawsense.data.ServiceRuntimeStatus
import ai.openclaw.clawsense.sensors.AndroidAudioSensorHal
import ai.openclaw.clawsense.sensors.CameraXImageSensorHal
import ai.openclaw.clawsense.work.WorkScheduler
import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class SensorForegroundService : LifecycleService() {
  private val tag = "ClawSenseService"
  private val repository: DeviceSessionRepository by lazy { AppGraph.repository(this) }
  private val audioHal by lazy {
    AndroidAudioSensorHal(
      context = this,
      config = AndroidAudioSensorHal.Config(
        silenceTimeoutMs = AUDIO_SESSION_SILENCE_TIMEOUT_MS,
        minVoicedMs = AUDIO_SESSION_MIN_VOICED_MS,
        maxClipMs = AUDIO_SESSION_MAX_CLIP_MS,
        uploadCooldownMs = AUDIO_SESSION_UPLOAD_COOLDOWN_MS,
        conversationContinuationGapMs = AUDIO_SESSION_CONTINUATION_GAP_MS,
      ),
    )
  }
  private val imageHal by lazy { CameraXImageSensorHal(this) }
  private val assistantTts by lazy { AssistantTtsController(this) }

  private var heartbeatJob: Job? = null
  private var stillCaptureJob: Job? = null
  private var videoCaptureJob: Job? = null
  private var assistantQueryTimeoutJob: Job? = null
  private val shutdownScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val shutdownMutex = Mutex()
  private val assistantMutex = Mutex()
  private var started = false
  @Volatile private var shuttingDown = false
  @Volatile private var sensorsReleased = false
  @Volatile private var audioSensorRunning = false
  @Volatile private var videoSensorRunning = false
  @Volatile private var assistantSpeechStopRequested = false
  @Volatile private var assistantAmbientDropUntilWallMs = 0L
  @Volatile private var lastAudioActivityElapsedMs = 0L
  @Volatile private var lastAutoVideoCaptureElapsedMs = 0L
  @Volatile private var autoVideoHourBucket = -1L
  @Volatile private var autoVideoDayBucket = -1L
  @Volatile private var autoVideoCountThisHour = 0
  @Volatile private var autoVideoCountThisDay = 0
  @Volatile private var nextStillCaptureDueAtMs = Long.MAX_VALUE

  private companion object {
    const val AUDIO_SESSION_SILENCE_TIMEOUT_MS = 2_400L
    const val AUDIO_SESSION_MIN_VOICED_MS = 256L
    const val AUDIO_SESSION_MAX_CLIP_MS = 60_000L
    const val AUDIO_SESSION_UPLOAD_COOLDOWN_MS = 400L
    const val AUDIO_SESSION_CONTINUATION_GAP_MS = 30_000L
    const val BASELINE_STILL_INTERVAL_MS = 60_000L
    const val ACTIVE_STILL_INTERVAL_MS = 10_000L
    const val ACTIVE_STILL_WINDOW_MS = 120_000L
    // The dedicated query recorder caps itself at queryMaxDurationMs (8s); the
    // watchdog only rescues the UI if the audio loop dies mid-capture.
    const val ASSISTANT_QUERY_WATCHDOG_MS = 12_000L
    const val ASSISTANT_QUERY_NO_SPEECH_MESSAGE =
      "这次没有录到清晰的提问人声。请靠近一点，点“问实时助手”后直接说一句问题。"
    const val ASSISTANT_QUERY_WATCHDOG_MESSAGE =
      "提问录音没有正常结束，请再点一次“问实时助手”。"
    const val ASSISTANT_ECHO_DRAIN_MS = AUDIO_SESSION_SILENCE_TIMEOUT_MS + 1_200L
    const val MANUAL_VIDEO_CLIP_MS = 6_000L
    const val AUTO_VIDEO_COOLDOWN_MS = 10 * 60 * 1000L
    const val MAX_THROTTLED_STILL_INTERVAL_MS = 5 * 60 * 1000L
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (SensorServiceController.isStopAction(intent)) {
      Log.d(tag, "Stop action received")
      repository.setServiceEnabled(false)
      repository.updateRuntimeStatus(
        ServiceRuntimeStatus(
          phase = ServicePhase.STOPPED,
          mode = CaptureMode.NONE,
        ),
      )
      WorkScheduler.cancelHeartbeat(this)
      beginShutdown(removeNotification = true)
      return START_NOT_STICKY
    }

    if (SensorServiceController.isAssistantQueryAction(intent)) {
      lifecycleScope.launch {
        triggerAssistantQuery(SensorServiceController.readAssistantModeHint(intent))
      }
    }
    if (SensorServiceController.isStopAssistantSpeakingAction(intent)) {
      lifecycleScope.launch {
        stopAssistantSpeaking()
      }
    }
    if (SensorServiceController.isCaptureVideoClipAction(intent)) {
      lifecycleScope.launch {
        triggerManualVideoClip()
      }
    }

    val hasAudioPermission = hasPermission(Manifest.permission.RECORD_AUDIO)
    val hasCameraPermission = hasPermission(Manifest.permission.CAMERA)
    startForegroundCompat(
      buildNotification(notificationText(hasAudioPermission, hasCameraPermission)),
      audioEnabled = hasAudioPermission,
      imageEnabled = hasCameraPermission,
    )

    if (!started) {
      started = true
      shuttingDown = false
      sensorsReleased = false
      Log.d(tag, "Foreground service starting")
      repository.setServiceEnabled(true)
      repository.updateRuntimeStatus(
        ServiceRuntimeStatus(
          phase = ServicePhase.STARTING,
          mode = CaptureMode.NONE,
        ),
      )
      WorkScheduler.scheduleHeartbeat(this)
      lifecycleScope.launch {
        runSensorLoops()
      }
    } else {
      val currentStatus = repository.runtimeStatus.value
      repository.updateRuntimeStatus(currentStatus.copy(updatedAt = System.currentTimeMillis()))
    }
    return START_STICKY
  }

  override fun onDestroy() {
    heartbeatJob?.cancel()
    stillCaptureJob?.cancel()
    videoCaptureJob?.cancel()
    resetRuntimeTracking()
    repository.updateRuntimeStatus(
      ServiceRuntimeStatus(
        phase = ServicePhase.STOPPED,
        mode = CaptureMode.NONE,
      ),
    )
    repository.updateAssistantSnapshot(
      AssistantInteractionSnapshot(
        phase = AssistantInteractionPhase.PASSIVE_SENSING,
      ),
    )
    if (!sensorsReleased) {
      shutdownScope.launch {
        stopSensorHals()
      }
    }
    super.onDestroy()
  }

  private suspend fun runSensorLoops() {
    repository.refresh()
    val session = repository.session.value
    if (session == null) {
      val message = "没有找到已配对设备，请重新配对后再启动。"
      Log.w(tag, "No paired session found; stopping foreground service")
      repository.setServiceEnabled(false)
      repository.recordError(message)
      repository.updateRuntimeStatus(
        ServiceRuntimeStatus(
          phase = ServicePhase.STOPPED,
          mode = CaptureMode.NONE,
          lastError = message,
        ),
      )
      stopForeground(STOP_FOREGROUND_REMOVE)
      WorkScheduler.cancelHeartbeat(this)
      stopSelf()
      return
    }

    val hasAudioPermission = hasPermission(Manifest.permission.RECORD_AUDIO)
    val hasCameraPermission = hasPermission(Manifest.permission.CAMERA)
    var audioActive = false
    var imageActive = false

    if (hasAudioPermission) {
      runCatching {
        audioHal.start { clip ->
          val activityAt = SystemClock.elapsedRealtime()
          lastAudioActivityElapsedMs = activityAt
          if (!repository.captureThrottleSnapshot().skipImmediateStillCapture) {
            val nextActiveCapture = activityAt + ACTIVE_STILL_INTERVAL_MS
            if (nextActiveCapture < nextStillCaptureDueAtMs) {
              nextStillCaptureDueAtMs = nextActiveCapture
            }
          }
          lifecycleScope.launch {
            try {
              handleCapturedAudioClip(clip)
            } catch (error: Throwable) {
              if (error is CancellationException) {
                throw error
              }
              if (error is ClawSenseAuthException) {
                Log.e(tag, "Audio upload unauthorized; stopping service", error)
                WorkScheduler.cancelHeartbeat(this@SensorForegroundService)
                beginShutdown(removeNotification = true)
                return@launch
              }
              Log.e(tag, "Audio upload failed", error)
            }
          }
        }
      }
        .onSuccess {
          audioActive = true
          audioSensorRunning = true
          Log.d(tag, "Audio HAL started")
        }
        .onFailure {
          val message = "音频初始化失败：${it.message ?: "未知错误"}"
          Log.e(tag, "Audio HAL start failed", it)
          repository.recordError(message)
        }
    }

    if (hasCameraPermission) {
      runCatching { imageHal.start() }
        .onSuccess {
          imageActive = true
          videoSensorRunning = true
          Log.d(tag, "Camera HAL started")
        }
        .onFailure {
          val message = "相机初始化失败：${it.message ?: "未知错误"}"
          Log.e(tag, "Camera HAL start failed", it)
          repository.recordError(message)
        }
    }

    val actualCaptureMode = when {
      audioActive && imageActive -> CaptureMode.FULL
      audioActive -> CaptureMode.AUDIO_ONLY
      imageActive -> CaptureMode.IMAGE_ONLY
      else -> CaptureMode.NONE
    }
    if (actualCaptureMode == CaptureMode.NONE) {
      val message = "没有成功启动任何传感器，请检查权限、系统占用或后台限制。"
      repository.setServiceEnabled(false)
      repository.recordError(message)
      repository.updateRuntimeStatus(
        ServiceRuntimeStatus(
          phase = ServicePhase.STOPPED,
          mode = CaptureMode.NONE,
          lastError = message,
        ),
      )
      stopForeground(STOP_FOREGROUND_REMOVE)
      WorkScheduler.cancelHeartbeat(this)
      stopSelf()
      return
    }

    repository.updateRuntimeStatus(
      ServiceRuntimeStatus(
        phase = ServicePhase.RUNNING,
        mode = actualCaptureMode,
      ),
    )
    if (audioActive) {
      markAssistantReady()
    } else {
      repository.updateAssistantSnapshot(
        AssistantInteractionSnapshot(
          phase = AssistantInteractionPhase.PASSIVE_SENSING,
          lastUpdatedAt = System.currentTimeMillis(),
        ),
      )
    }

    heartbeatJob = lifecycleScope.launch {
      var nextHeartbeatIntervalSec = session.heartbeatIntervalSec.coerceAtLeast(30)
      while (true) {
        try {
          val heartbeatResult = repository.sendHeartbeat(
            HeartbeatPayloadFactory.create(
              context = this@SensorForegroundService,
              appState = "service",
              heartbeatIntervalSec = nextHeartbeatIntervalSec,
            ),
          )
          nextHeartbeatIntervalSec = heartbeatResult.heartbeatIntervalSec.coerceAtLeast(30)
          heartbeatResult.captureDirective?.let { directive ->
            maybeTriggerAutoVideoClip(directive)
          }
        } catch (error: Throwable) {
          if (error is CancellationException) {
            throw error
          }
          if (error is ClawSenseAuthException) {
            Log.e(tag, "Heartbeat unauthorized; stopping service", error)
            WorkScheduler.cancelHeartbeat(this@SensorForegroundService)
            beginShutdown(removeNotification = true)
            return@launch
          }
          Log.e(tag, "Heartbeat failed", error)
        }
        delay(nextHeartbeatIntervalSec.toLong() * 1000)
      }
    }

    if (imageActive) {
      stillCaptureJob = lifecycleScope.launch {
        nextStillCaptureDueAtMs = SystemClock.elapsedRealtime() + BASELINE_STILL_INTERVAL_MS
        while (true) {
          val now = SystemClock.elapsedRealtime()
          val waitMs = nextStillCaptureDueAtMs - now
          if (waitMs > 0) {
            delay(minOf(waitMs, 1000L))
            continue
          }
          val activeWindow = isWithinActiveWindow(now)
          val throttle = repository.captureThrottleSnapshot()
          val nextInterval = stillCaptureIntervalMs(activeWindow, throttle.stillIntervalMultiplier)
          if (throttle.skipImmediateStillCapture) {
            Log.d(
              tag,
              "Deferring still capture due to throttle level=${throttle.level} reason=${throttle.reason} nextInMs=$nextInterval",
            )
            nextStillCaptureDueAtMs = SystemClock.elapsedRealtime() + nextInterval
            continue
          }
          val captureContext = if (activeWindow) "active-window" else "baseline-snapshot"
          try {
            Log.d(
              tag,
              "Triggering still capture context=$captureContext throttle=${throttle.level} intervalMs=$nextInterval",
            )
            val frame = imageHal.captureStill()
            val taggedFrame = frame.copy(note = captureContext)
            Log.d(tag, "Uploading image ${taggedFrame.fileName} bytes=${taggedFrame.bytes.size}")
            repository.uploadImage(taggedFrame)
            Log.d(tag, "Image upload succeeded")
          } catch (error: Throwable) {
            if (error is CancellationException) {
              throw error
            }
            if (error is ClawSenseAuthException) {
              Log.e(tag, "Image upload unauthorized; stopping service", error)
              WorkScheduler.cancelHeartbeat(this@SensorForegroundService)
              beginShutdown(removeNotification = true)
              return@launch
            }
            Log.e(tag, "Image upload failed", error)
          }
          val refreshedThrottle = repository.captureThrottleSnapshot()
          nextStillCaptureDueAtMs = SystemClock.elapsedRealtime() + stillCaptureIntervalMs(
            activeWindow = isWithinActiveWindow(SystemClock.elapsedRealtime()),
            multiplier = refreshedThrottle.stillIntervalMultiplier,
          )
        }
      }
    }
  }

  private fun isWithinActiveWindow(nowElapsed: Long): Boolean {
    val lastActivity = lastAudioActivityElapsedMs
    return lastActivity > 0 && nowElapsed - lastActivity <= ACTIVE_STILL_WINDOW_MS
  }

  private fun stillCaptureIntervalMs(activeWindow: Boolean, multiplier: Int): Long {
    val base = if (activeWindow) ACTIVE_STILL_INTERVAL_MS else BASELINE_STILL_INTERVAL_MS
    return (base * multiplier.coerceAtLeast(1)).coerceAtMost(MAX_THROTTLED_STILL_INTERVAL_MS)
  }

  private fun beginShutdown(removeNotification: Boolean) {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    heartbeatJob?.cancel()
    stillCaptureJob?.cancel()
    videoCaptureJob?.cancel()
    resetRuntimeTracking()
    if (removeNotification) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }
    shutdownScope.launch {
      stopSensorHals()
      withContext(Dispatchers.Main.immediate) {
        stopSelf()
      }
    }
  }

  private suspend fun stopSensorHals() {
    shutdownMutex.withLock {
      if (sensorsReleased) {
        return@withLock
      }
      audioSensorRunning = false
      videoSensorRunning = false
      assistantQueryTimeoutJob?.cancel()
      assistantQueryTimeoutJob = null
      runCatching { audioHal.stop() }
        .onFailure { Log.w(tag, "Audio HAL stop failed", it) }
      runCatching { imageHal.stop() }
        .onFailure { Log.w(tag, "Camera HAL stop failed", it) }
      runCatching { assistantTts.shutdown() }
        .onFailure { Log.w(tag, "Assistant TTS shutdown failed", it) }
      sensorsReleased = true
    }
  }

  private fun resetRuntimeTracking() {
    started = false
    audioSensorRunning = false
    videoSensorRunning = false
    assistantQueryTimeoutJob?.cancel()
    assistantQueryTimeoutJob = null
    assistantAmbientDropUntilWallMs = 0L
    lastAudioActivityElapsedMs = 0L
    nextStillCaptureDueAtMs = Long.MAX_VALUE
  }

  private suspend fun handleCapturedAudioClip(clip: CapturedAudioClip) {
    if (shouldDropAssistantEchoClip(clip)) {
      Log.d(
        tag,
        "Dropping ambient audio clip inside assistant echo drain capturedAt=${clip.capturedAt} durationMs=${clip.durationMs} dropUntil=$assistantAmbientDropUntilWallMs",
      )
      return
    }

    val phase = repository.assistantSnapshot.value.phase
    if (
      phase == AssistantInteractionPhase.RECORDING_QUERY ||
        phase == AssistantInteractionPhase.WAITING_ANSWER ||
        phase == AssistantInteractionPhase.SPEAKING_ANSWER
    ) {
      Log.d(tag, "Dropping ambient audio clip during assistant phase=$phase")
      return
    }

    val throttle = repository.captureThrottleSnapshot()
    if (throttle.deferLowSignalAudio && isLowSignalAmbientAudio(clip)) {
      Log.d(
        tag,
        "Deferring low-signal audio clip due to throttle level=${throttle.level} reason=${throttle.reason} durationMs=${clip.durationMs} note=${clip.note}",
      )
      repository.deferAudioUpload(
        clip = clip,
        reason = "服务端分析拥堵，低信号音频已延后补传；当前会优先保留关键音频和图片。",
      )
      return
    }

    Log.d(
      tag,
      "Uploading audio clip ${clip.fileName} capturedAt=${clip.capturedAt} bytes=${clip.bytes.size} note=${clip.note}",
    )
    repository.uploadAudio(clip)
    Log.d(tag, "Audio upload succeeded")
  }

  private suspend fun triggerManualVideoClip() {
    if (!videoSensorRunning || repository.runtimeStatus.value.phase != ServicePhase.RUNNING) {
      repository.recordError("视频录制需要相机服务正在运行，请先启动感知服务。")
      return
    }
    if (videoCaptureJob?.isActive == true) {
      repository.recordError("视频片段正在录制中，请稍后再试。")
      return
    }
    videoCaptureJob = lifecycleScope.launch {
      try {
        Log.d(tag, "Manual video clip capture requested")
        repository.updateVideoCaptureStatus("正在录制 6 秒视频片段…", inProgress = true)
        val clip = imageHal.recordVideoClip(MANUAL_VIDEO_CLIP_MS).copy(
          note = "manual-video-clip androidVideoM2=1 clipMs=$MANUAL_VIDEO_CLIP_MS",
        )
        repository.updateVideoCaptureStatus(
          "正在上传视频片段（${clip.bytes.size / 1024} KB，关键帧 ${clip.keyframes.size} 张）…",
          inProgress = true,
        )
        Log.d(
          tag,
          "Uploading video clip ${clip.fileName} bytes=${clip.bytes.size} keyframes=${clip.keyframes.size}",
        )
        repository.uploadVideo(clip)
        repository.updateVideoCaptureStatus("视频片段已提交；如果服务端拥堵，会自动补传。", inProgress = false)
        Log.d(tag, "Video upload succeeded")
      } catch (error: Throwable) {
        if (error is CancellationException) {
          repository.updateVideoCaptureStatus(null, inProgress = false)
          throw error
        }
        if (error is ClawSenseAuthException) {
          Log.e(tag, "Video upload unauthorized; stopping service", error)
          repository.updateVideoCaptureStatus("视频上传失败：设备凭证失效，请重新配对。", inProgress = false)
          WorkScheduler.cancelHeartbeat(this@SensorForegroundService)
          beginShutdown(removeNotification = true)
          return@launch
        }
        Log.e(tag, "Video capture/upload failed", error)
        repository.updateVideoCaptureStatus(
          "视频上传失败：${error.message ?: "未知错误"}",
          inProgress = false,
        )
        repository.recordError("视频上传失败：${error.message ?: "未知错误"}")
      }
    }
  }

  private suspend fun maybeTriggerAutoVideoClip(directive: CaptureVideoDirective) {
    if (directive.type != "video_clip") {
      Log.d(tag, "Ignoring unsupported capture directive type=${directive.type}")
      return
    }
    val nowWallMs = System.currentTimeMillis()
    val expiresAt = directive.expiresAt
    if (expiresAt != null && expiresAt <= nowWallMs) {
      Log.d(tag, "Ignoring expired auto-video directive id=${directive.directiveId}")
      return
    }
    val preferences = repository.capturePreferences.value
    if (!preferences.autoVideoEnabled) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; auto video disabled")
      return
    }
    if (!videoSensorRunning || repository.runtimeStatus.value.phase != ServicePhase.RUNNING) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; video sensor not running")
      return
    }
    if (videoCaptureJob?.isActive == true) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; video capture already active")
      return
    }
    val assistantPhase = repository.assistantSnapshot.value.phase
    if (
      assistantPhase == AssistantInteractionPhase.RECORDING_QUERY ||
        assistantPhase == AssistantInteractionPhase.WAITING_ANSWER ||
        assistantPhase == AssistantInteractionPhase.SPEAKING_ANSWER
    ) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; assistant phase=$assistantPhase")
      return
    }
    val throttle = repository.captureThrottleSnapshot()
    if (throttle.pauseAutoVideo) {
      Log.d(
        tag,
        "Skipping auto-video directive id=${directive.directiveId}; capture throttle level=${throttle.level} reason=${throttle.reason}",
      )
      return
    }
    val nowElapsed = SystemClock.elapsedRealtime()
    if (lastAutoVideoCaptureElapsedMs > 0L && nowElapsed - lastAutoVideoCaptureElapsedMs < AUTO_VIDEO_COOLDOWN_MS) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; cooldown active")
      return
    }
    resetAutoVideoCountersIfNeeded(nowWallMs)
    if (autoVideoCountThisHour >= preferences.autoVideoMaxPerHour.coerceAtLeast(0)) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; hourly limit reached")
      return
    }
    if (autoVideoCountThisDay >= preferences.autoVideoMaxPerDay.coerceAtLeast(0)) {
      Log.d(tag, "Skipping auto-video directive id=${directive.directiveId}; daily limit reached")
      return
    }
    lastAutoVideoCaptureElapsedMs = nowElapsed
    autoVideoCountThisHour += 1
    autoVideoCountThisDay += 1
    val durationMs = directive.durationMs.coerceIn(3_000L, MANUAL_VIDEO_CLIP_MS)
    val note = listOfNotNull(
      "auto-video-trigger",
      "androidVideoM2=1",
      "clipMs=$durationMs",
      "triggerSource=heartbeat-directive",
      "directiveId=${sanitizeNoteToken(directive.directiveId)}",
      "triggerReason=${sanitizeNoteToken(directive.reason)}",
      directive.sourceEventId?.let { "sourceEventId=${sanitizeNoteToken(it)}" },
      directive.sourceText?.let { "sourceText=${sanitizeNoteToken(it, 120)}" },
    ).joinToString(" ")

    videoCaptureJob = lifecycleScope.launch {
      try {
        Log.d(
          tag,
          "Auto video clip capture requested directiveId=${directive.directiveId} reason=${directive.reason}",
        )
        repository.updateVideoCaptureStatus("检测到关键线索，正在自动录制 6 秒视频片段…", inProgress = true)
        val clip = imageHal.recordVideoClip(durationMs).copy(note = note)
        repository.updateVideoCaptureStatus(
          "正在上传自动视频片段（${clip.bytes.size / 1024} KB，关键帧 ${clip.keyframes.size} 张）…",
          inProgress = true,
        )
        repository.uploadVideo(clip)
        repository.updateVideoCaptureStatus("自动视频片段已提交；触发原因已写入 evidence。", inProgress = false)
        Log.d(tag, "Auto video upload succeeded directiveId=${directive.directiveId}")
      } catch (error: Throwable) {
        if (error is CancellationException) {
          repository.updateVideoCaptureStatus(null, inProgress = false)
          rollbackAutoVideoCounterReservation()
          throw error
        }
        if (error is ClawSenseAuthException) {
          Log.e(tag, "Auto video upload unauthorized; stopping service", error)
          repository.updateVideoCaptureStatus("自动视频上传失败：设备凭证失效，请重新配对。", inProgress = false)
          rollbackAutoVideoCounterReservation()
          WorkScheduler.cancelHeartbeat(this@SensorForegroundService)
          beginShutdown(removeNotification = true)
          return@launch
        }
        Log.e(tag, "Auto video capture/upload failed directiveId=${directive.directiveId}", error)
        rollbackAutoVideoCounterReservation()
        repository.updateVideoCaptureStatus(
          "自动视频上传失败：${error.message ?: "未知错误"}",
          inProgress = false,
        )
        repository.recordError("自动视频上传失败：${error.message ?: "未知错误"}")
      }
    }
  }

  private fun rollbackAutoVideoCounterReservation() {
    autoVideoCountThisHour = (autoVideoCountThisHour - 1).coerceAtLeast(0)
    autoVideoCountThisDay = (autoVideoCountThisDay - 1).coerceAtLeast(0)
  }

  private fun resetAutoVideoCountersIfNeeded(nowWallMs: Long) {
    val hourBucket = nowWallMs / (60 * 60 * 1000L)
    val dayBucket = nowWallMs / (24 * 60 * 60 * 1000L)
    if (hourBucket != autoVideoHourBucket) {
      autoVideoHourBucket = hourBucket
      autoVideoCountThisHour = 0
    }
    if (dayBucket != autoVideoDayBucket) {
      autoVideoDayBucket = dayBucket
      autoVideoCountThisDay = 0
    }
  }

  private fun isLowSignalAmbientAudio(clip: CapturedAudioClip): Boolean {
    val note = clip.note ?: return (clip.durationMs ?: Long.MAX_VALUE) <= 4_500L
    val voicedMs = noteValue(note, "voicedMs")?.toLongOrNull()
    val clipMs = noteValue(note, "clipMs")?.toLongOrNull() ?: clip.durationMs
    val peakRms = noteValue(note, "peakRms")?.toDoubleOrNull()
    if (voicedMs != null && voicedMs < 1_500L) {
      return true
    }
    if (voicedMs != null && clipMs != null && clipMs > 0L && voicedMs.toDouble() / clipMs.toDouble() < 0.18) {
      return true
    }
    if (peakRms != null && peakRms < 0.035) {
      return true
    }
    return false
  }

  private fun shouldDropAssistantEchoClip(clip: CapturedAudioClip): Boolean {
    val dropUntil = assistantAmbientDropUntilWallMs
    if (dropUntil <= 0L) {
      return false
    }
    val capturedAt = clip.capturedAt
    if (capturedAt <= 0L) {
      return System.currentTimeMillis() <= dropUntil
    }
    return capturedAt <= dropUntil
  }

  private fun armAssistantEchoDrain(nowWallMs: Long = System.currentTimeMillis()) {
    assistantAmbientDropUntilWallMs = nowWallMs + ASSISTANT_ECHO_DRAIN_MS
  }

  private fun noteValue(note: String, key: String): String? {
    val prefix = "$key="
    return note
      .split(' ')
      .firstOrNull { it.startsWith(prefix) }
      ?.removePrefix(prefix)
  }

  private suspend fun triggerAssistantQuery(modeHint: AssistantModeHint) {
    if (!audioSensorRunning) {
      repository.updateAssistantSnapshot(
        AssistantInteractionSnapshot(
          phase = AssistantInteractionPhase.ERROR_RECOVERY,
          lastUpdatedAt = System.currentTimeMillis(),
          lastError = "实时助手需要正在运行的麦克风链路，请先启动感知服务。",
        ),
      )
      return
    }
    var shouldArmQuery = false
    assistantMutex.withLock {
      val phase = repository.assistantSnapshot.value.phase
      if (
        phase == AssistantInteractionPhase.RECORDING_QUERY ||
          phase == AssistantInteractionPhase.WAITING_ANSWER ||
          phase == AssistantInteractionPhase.SPEAKING_ANSWER
      ) {
        repository.updateAssistantSnapshot(
          repository.assistantSnapshot.value.copy(
            phase = AssistantInteractionPhase.ERROR_RECOVERY,
            lastUpdatedAt = System.currentTimeMillis(),
            lastError = "助手正在处理上一轮问题，请等它说完再问。",
          ),
        )
      } else {
        repository.updateAssistantSnapshot(
          AssistantInteractionSnapshot(
            phase = AssistantInteractionPhase.RECORDING_QUERY,
            lastUpdatedAt = System.currentTimeMillis(),
            mode = modeHint,
          ),
        )
        shouldArmQuery = true
      }
    }
    if (!shouldArmQuery) {
      return
    }
    val armed = audioHal.beginAssistantQueryCapture { clip ->
      onAssistantQueryCaptured(clip, modeHint)
    }
    if (!armed) {
      Log.w(tag, "Assistant query capture already in flight; ignoring trigger")
      markAssistantReady(lastError = "上一轮提问录音还没结束，请稍候再试。")
      return
    }
    Log.d(tag, "Assistant query recorder armed mode=$modeHint watchdogMs=$ASSISTANT_QUERY_WATCHDOG_MS")
    scheduleAssistantQueryWatchdog(modeHint)
  }

  private fun onAssistantQueryCaptured(clip: CapturedAudioClip?, modeHint: AssistantModeHint) {
    assistantQueryTimeoutJob?.cancel()
    assistantQueryTimeoutJob = null
    lifecycleScope.launch {
      val phaseOk = assistantMutex.withLock {
        if (repository.assistantSnapshot.value.phase != AssistantInteractionPhase.RECORDING_QUERY) {
          false
        } else {
          if (clip != null) {
            repository.updateAssistantSnapshot(
              AssistantInteractionSnapshot(
                phase = AssistantInteractionPhase.WAITING_ANSWER,
                lastUpdatedAt = System.currentTimeMillis(),
                mode = modeHint,
              ),
            )
          }
          true
        }
      }
      if (!phaseOk) {
        Log.w(tag, "Assistant query capture finished outside RECORDING_QUERY phase; dropping result")
        return@launch
      }
      if (clip == null) {
        Log.d(tag, "Assistant query capture delivered no speech mode=$modeHint")
        markAssistantReady(lastError = ASSISTANT_QUERY_NO_SPEECH_MESSAGE)
        return@launch
      }
      Log.d(
        tag,
        "Assistant query clip captured mode=$modeHint durationMs=${clip.durationMs} bytes=${clip.bytes.size} note=${clip.note}",
      )
      processAssistantQuery(clip, modeHint)
    }
  }

  private fun scheduleAssistantQueryWatchdog(modeHint: AssistantModeHint) {
    assistantQueryTimeoutJob?.cancel()
    assistantQueryTimeoutJob = lifecycleScope.launch {
      // The recorder guarantees a result within queryMaxDurationMs; this only
      // recovers the UI if the audio loop dies mid-capture.
      delay(ASSISTANT_QUERY_WATCHDOG_MS)
      var timedOut = false
      assistantMutex.withLock {
        if (repository.assistantSnapshot.value.phase == AssistantInteractionPhase.RECORDING_QUERY) {
          timedOut = true
          repository.updateAssistantSnapshot(
            AssistantInteractionSnapshot(
              phase = AssistantInteractionPhase.ERROR_RECOVERY,
              lastUpdatedAt = System.currentTimeMillis(),
              mode = modeHint,
              lastError = ASSISTANT_QUERY_WATCHDOG_MESSAGE,
            ),
          )
        }
      }
      if (timedOut) {
        Log.w(tag, "Assistant query recorder watchdog fired mode=$modeHint")
        markAssistantReady(lastError = ASSISTANT_QUERY_WATCHDOG_MESSAGE)
      }
    }
  }

  private suspend fun processAssistantQuery(
    clip: CapturedAudioClip,
    modeHint: AssistantModeHint,
  ) {
    try {
      Log.d(tag, "Assistant query submitting mode=$modeHint durationMs=${clip.durationMs} bytes=${clip.bytes.size}")
      val contextWindowHint = when (modeHint) {
        AssistantModeHint.MEETING,
        AssistantModeHint.DESK -> AssistantRecentContextWindowHint.LAST_5M
        AssistantModeHint.AUTO -> AssistantRecentContextWindowHint.LAST_60S
      }
      val response = repository.queryAssistant(
        clip = clip,
        windowHint = contextWindowHint,
        modeHint = modeHint,
      )
      Log.d(
        tag,
        "Assistant query answered mode=${response.modeUsed} source=${response.answerSource ?: "unknown"} action=${response.actionIntent?.type ?: "none"} queryTextLen=${response.queryText.length} answerLen=${response.answerText.length} spokenLen=${response.answerSpokenText.length} sttProvider=${response.stt?.provider ?: "none"} sttFailure=${response.stt?.failureReason ?: "none"} sttAccepted=${response.stt?.queryAccepted ?: false} sttRewrite=${response.stt?.queryRewriteReason ?: "none"} rawQueryLen=${response.stt?.rawQueryText?.length ?: 0}${assistantQueryDebugPreview(response)} audioRecheckAttempted=${response.audioRecheck?.attempted ?: false} audioRecheckRefreshed=${response.audioRecheck?.refreshed ?: false} audioRecheckTranscripts=${response.audioRecheck?.transcriptCount ?: 0}/${response.audioRecheck?.resultCount ?: 0}",
      )
      speakAssistantResponse(response)
    } catch (error: Throwable) {
      if (error is CancellationException) {
        throw error
      }
      if (error is ClawSenseAuthException) {
        Log.e(tag, "Assistant query unauthorized; stopping service", error)
        repository.setServiceEnabled(false)
        repository.recordError("设备凭证已失效，请重新配对后再使用实时助手。")
        repository.updateAssistantSnapshot(
          AssistantInteractionSnapshot(
            phase = AssistantInteractionPhase.ERROR_RECOVERY,
            lastUpdatedAt = System.currentTimeMillis(),
            lastError = "设备凭证已失效，请重新配对后再试。",
          ),
        )
        WorkScheduler.cancelHeartbeat(this)
        beginShutdown(removeNotification = true)
        return
      }
      Log.e(tag, "Assistant query failed", error)
      repository.updateAssistantSnapshot(
        AssistantInteractionSnapshot(
          phase = AssistantInteractionPhase.ERROR_RECOVERY,
          lastUpdatedAt = System.currentTimeMillis(),
          lastError = "助手回答失败：${error.message ?: "未知错误"}",
        ),
      )
      markAssistantReady(
        lastError = "助手回答失败：${error.message ?: "未知错误"}",
      )
    }
  }

  private fun assistantQueryDebugPreview(response: AssistantQueryResponse): String {
    if (!BuildConfig.DEBUG) {
      return ""
    }
    val query = response.queryText.takeIf { it.isNotBlank() }?.let { previewText(it) }
    val raw = response.stt?.rawQueryText?.takeIf { it.isNotBlank() }?.let { previewText(it) }
    return " queryPreview=${query ?: "-"} rawQueryPreview=${raw ?: "-"}"
  }

  private fun previewText(text: String): String {
    val normalized = text
      .replace(Regex("\\s+"), " ")
      .trim()
    return if (normalized.length <= 32) {
      normalized
    } else {
      normalized.take(32) + "…"
    }
  }

  private suspend fun speakAssistantResponse(response: AssistantQueryResponse) {
    armAssistantEchoDrain()
    repository.updateAssistantSnapshot(
      AssistantInteractionSnapshot(
        phase = AssistantInteractionPhase.SPEAKING_ANSWER,
        lastUpdatedAt = System.currentTimeMillis(),
        mode = response.modeUsed,
        queryText = response.queryText,
        answerText = response.answerText,
        answerSpokenText = response.answerSpokenText,
        answeredAt = response.answeredAt,
      ),
    )
    val ttsResult = assistantTts.speak(response.answerSpokenText)
    val stoppedByUser = assistantSpeechStopRequested
    assistantSpeechStopRequested = false
    if (ttsResult.isFailure) {
      val failureMessage = ttsResult.exceptionOrNull()?.message ?: "TTS 播报失败"
      Log.w(tag, "Assistant TTS failed: $failureMessage")
      repository.updateAssistantSnapshot(
        AssistantInteractionSnapshot(
          phase = AssistantInteractionPhase.ERROR_RECOVERY,
          lastUpdatedAt = System.currentTimeMillis(),
          mode = response.modeUsed,
          queryText = response.queryText,
          answerText = response.answerText,
          answerSpokenText = response.answerSpokenText,
          answeredAt = response.answeredAt,
          lastError = failureMessage,
        ),
      )
      markAssistantReady(
        response = response,
        lastError = failureMessage,
      )
      return
    }
    if (stoppedByUser) {
      Log.d(tag, "Assistant TTS stopped by user")
      armAssistantEchoDrain()
      markAssistantReady(
        response = response,
        lastError = "已停止朗读。",
      )
      return
    }
    Log.d(tag, "Assistant TTS completed")
    armAssistantEchoDrain()
    markAssistantReady(response = response)
  }

  private suspend fun stopAssistantSpeaking() {
    val snapshot = repository.assistantSnapshot.value
    val wasSpeaking = snapshot.phase == AssistantInteractionPhase.SPEAKING_ANSWER
    if (wasSpeaking) {
      assistantSpeechStopRequested = true
      assistantTts.stopSpeaking()
      armAssistantEchoDrain()
      Log.d(tag, "Assistant TTS stop requested")
    }
    repository.updateAssistantSnapshot(
      snapshot.copy(
        phase = if (audioSensorRunning) {
          AssistantInteractionPhase.WAKEWORD_ARMED
        } else {
          AssistantInteractionPhase.PASSIVE_SENSING
        },
        lastUpdatedAt = System.currentTimeMillis(),
        lastError = if (wasSpeaking) {
          "已停止朗读。"
        } else {
          "当前没有正在朗读的回答。"
        },
      ),
    )
  }

  private fun markAssistantReady(
    response: AssistantQueryResponse? = null,
    lastError: String? = null,
  ) {
    repository.updateAssistantSnapshot(
      AssistantInteractionSnapshot(
        phase = if (audioSensorRunning) {
          AssistantInteractionPhase.WAKEWORD_ARMED
        } else {
          AssistantInteractionPhase.PASSIVE_SENSING
        },
        lastUpdatedAt = System.currentTimeMillis(),
        mode = response?.modeUsed ?: AssistantModeHint.AUTO,
        queryText = response?.queryText,
        answerText = response?.answerText,
        answerSpokenText = response?.answerSpokenText,
        answeredAt = response?.answeredAt,
        lastError = lastError,
      ),
    )
  }

  private fun startForegroundCompat(
    notification: Notification,
    audioEnabled: Boolean,
    imageEnabled: Boolean,
  ) {
    val baseType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    var typeMask = baseType
    if (audioEnabled) {
      typeMask = typeMask or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    if (imageEnabled) {
      typeMask = typeMask or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    ServiceCompat.startForeground(
      this,
      SensorServiceController.NOTIFICATION_ID,
      notification,
      typeMask,
    )
  }

  private fun buildNotification(content: String): Notification {
    val openIntent = PendingIntent.getActivity(
      this,
      10,
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val stopIntent = PendingIntent.getService(
      this,
      11,
      Intent(this, SensorForegroundService::class.java).setAction("ai.openclaw.clawsense.action.STOP"),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    return NotificationCompat.Builder(this, SensorServiceController.CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle(getString(R.string.notification_title))
      .setContentText(content)
      .setContentIntent(openIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, getString(R.string.notification_action_open), openIntent)
      .addAction(0, getString(R.string.notification_action_stop), stopIntent)
      .build()
  }

  private fun hasPermission(permission: String): Boolean {
    if (permission == Manifest.permission.POST_NOTIFICATIONS && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return true
    }
    return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun notificationText(hasAudioPermission: Boolean, hasCameraPermission: Boolean): String {
    return when {
      hasAudioPermission && hasCameraPermission -> getString(R.string.notification_text)
      hasAudioPermission -> getString(R.string.notification_text_audio_only)
      hasCameraPermission -> getString(R.string.notification_text_camera_only)
      else -> getString(R.string.notification_text_waiting)
    }
  }

  private fun sanitizeNoteToken(value: String, maxLength: Int = 80): String {
    return value
      .trim()
      .replace(Regex("\\s+"), "_")
      .replace(Regex("[^A-Za-z0-9_.:=\\-\\u4e00-\\u9fa5]"), "")
      .take(maxLength)
  }
}
