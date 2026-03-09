package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.MainActivity
import ai.openclaw.clawsense.R
import ai.openclaw.clawsense.data.CaptureMode
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
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SensorForegroundService : LifecycleService() {
  private val tag = "ClawSenseService"
  private val repository: DeviceSessionRepository by lazy { AppGraph.repository(this) }
  private val audioHal by lazy { AndroidAudioSensorHal(this) }
  private val imageHal by lazy { CameraXImageSensorHal(this) }

  private var heartbeatJob: Job? = null
  private var stillCaptureJob: Job? = null
  private var started = false

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
      stopSelf()
      return START_NOT_STICKY
    }

    val hasAudioPermission = hasPermission(Manifest.permission.RECORD_AUDIO)
    val hasCameraPermission = hasPermission(Manifest.permission.CAMERA)
    val captureMode = when {
      hasAudioPermission && hasCameraPermission -> CaptureMode.FULL
      hasAudioPermission -> CaptureMode.AUDIO_ONLY
      hasCameraPermission -> CaptureMode.IMAGE_ONLY
      else -> CaptureMode.NONE
    }
    startForegroundCompat(
      buildNotification(notificationText(hasAudioPermission, hasCameraPermission)),
      audioEnabled = hasAudioPermission,
      imageEnabled = hasCameraPermission,
    )

    if (!started) {
      started = true
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
      repository.updateRuntimeStatus(
        ServiceRuntimeStatus(
          phase = ServicePhase.RUNNING,
          mode = captureMode,
        ),
      )
    }
    return START_STICKY
  }

  override fun onDestroy() {
    super.onDestroy()
    lifecycleScope.launch {
      audioHal.stop()
      imageHal.stop()
    }
    heartbeatJob?.cancel()
    stillCaptureJob?.cancel()
    started = false
    repository.updateRuntimeStatus(
      ServiceRuntimeStatus(
        phase = ServicePhase.STOPPED,
        mode = CaptureMode.NONE,
      ),
    )
  }

  private suspend fun runSensorLoops() {
    repository.refresh()
    val session = repository.session.value
    if (session == null) {
      Log.w(tag, "No paired session found; stopping foreground service")
      repository.updateRuntimeStatus(
        ServiceRuntimeStatus(
          phase = ServicePhase.ERROR,
          mode = CaptureMode.NONE,
          lastError = "没有找到已配对设备，请重新配对后再启动。",
        ),
      )
      stopForeground(STOP_FOREGROUND_REMOVE)
      WorkScheduler.cancelHeartbeat(this)
      stopSelf()
      return
    }

    val hasAudioPermission = hasPermission(Manifest.permission.RECORD_AUDIO)
    val hasCameraPermission = hasPermission(Manifest.permission.CAMERA)
    val captureMode = when {
      hasAudioPermission && hasCameraPermission -> CaptureMode.FULL
      hasAudioPermission -> CaptureMode.AUDIO_ONLY
      hasCameraPermission -> CaptureMode.IMAGE_ONLY
      else -> CaptureMode.NONE
    }
    if (hasAudioPermission) {
      audioHal.start { clip ->
        Log.d(tag, "Uploading audio clip ${clip.fileName} bytes=${clip.bytes.size}")
        runCatching { repository.uploadAudio(clip) }
          .onSuccess { Log.d(tag, "Audio upload succeeded") }
          .onFailure { Log.e(tag, "Audio upload failed", it) }
      }
    }

    if (hasCameraPermission) {
      runCatching { imageHal.start() }
        .onSuccess { Log.d(tag, "Camera HAL started") }
        .onFailure {
          Log.e(tag, "Camera HAL start failed", it)
          repository.updateRuntimeStatus(
            ServiceRuntimeStatus(
              phase = ServicePhase.ERROR,
              mode = CaptureMode.NONE,
              lastError = "相机初始化失败：${it.message ?: "未知错误"}",
            ),
          )
        }
    }

    repository.updateRuntimeStatus(
      ServiceRuntimeStatus(
        phase = ServicePhase.RUNNING,
        mode = captureMode,
      ),
    )

    heartbeatJob = lifecycleScope.launch {
      var nextHeartbeatIntervalSec = session.heartbeatIntervalSec.coerceAtLeast(30)
      while (true) {
        runCatching {
          nextHeartbeatIntervalSec = repository.sendHeartbeat(
            HeartbeatPayloadFactory.create(
              context = this@SensorForegroundService,
              appState = "service",
              heartbeatIntervalSec = nextHeartbeatIntervalSec,
            ),
          ).coerceAtLeast(30)
        }
          .onFailure { Log.e(tag, "Heartbeat failed", it) }
        delay(nextHeartbeatIntervalSec.toLong() * 1000)
      }
    }

    if (hasCameraPermission) {
      stillCaptureJob = lifecycleScope.launch {
        delay(TimeUnit.SECONDS.toMillis(15))
        while (true) {
          runCatching {
            Log.d(tag, "Triggering still capture")
            val frame = imageHal.captureStill()
            Log.d(tag, "Uploading image ${frame.fileName} bytes=${frame.bytes.size}")
            repository.uploadImage(frame)
          }
            .onSuccess { Log.d(tag, "Image upload succeeded") }
            .onFailure { Log.e(tag, "Image upload failed", it) }
          delay(TimeUnit.MINUTES.toMillis(5))
        }
      }
    }
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
}
