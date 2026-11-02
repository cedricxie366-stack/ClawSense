package ai.openclaw.clawsense.debug

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.BuildConfig
import ai.openclaw.clawsense.data.AssistantModeHint
import ai.openclaw.clawsense.data.ServiceRuntimeStatus
import ai.openclaw.clawsense.service.SensorForegroundService
import ai.openclaw.clawsense.service.SensorServiceController
import ai.openclaw.clawsense.work.WorkScheduler
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import java.util.Locale

class DebugSessionRepairReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pendingResult = goAsync()
    val setupCode = intent.getStringExtra(EXTRA_SETUP_CODE)?.trim().orEmpty()
    val host = intent.getStringExtra(EXTRA_HOST)?.trim().orEmpty()
    val token = intent.getStringExtra(EXTRA_TOKEN)?.trim().orEmpty()
    val deviceName = intent.getStringExtra(EXTRA_DEVICE_NAME)?.trim()
      ?: Build.MODEL.ifBlank { "ClawSense Android" }
    val startSensing = intent.getBooleanExtra(EXTRA_START_SENSING, false)
    val stopSensing = intent.getBooleanExtra(EXTRA_STOP_SENSING, false)
    val stopAfterMs = intent.getLongExtra(EXTRA_STOP_AFTER_MS, 0L).coerceIn(0L, 120_000L)
    val triggerAssistantQuery = intent.getBooleanExtra(EXTRA_TRIGGER_ASSISTANT_QUERY, false)
    val stopAssistantSpeaking = intent.getBooleanExtra(EXTRA_STOP_ASSISTANT_SPEAKING, false)
    val captureVideoClip = intent.getBooleanExtra(EXTRA_CAPTURE_VIDEO_CLIP, false)
    val injectThrottle = intent.getBooleanExtra(EXTRA_INJECT_THROTTLE, false)
    val throttleDurationMs = intent.getLongExtra(EXTRA_THROTTLE_DURATION_MS, DEFAULT_THROTTLE_DURATION_MS)
    val throttleQueueDepth = intent.getIntExtra(EXTRA_THROTTLE_QUEUE_DEPTH, DEFAULT_THROTTLE_QUEUE_DEPTH)
    val modeHint = runCatching {
      AssistantModeHint.valueOf(
        intent.getStringExtra(EXTRA_ASSISTANT_MODE_HINT)
          ?.trim()
          ?.uppercase(Locale.ROOT)
          .orEmpty(),
      )
    }.getOrDefault(AssistantModeHint.AUTO)
    val appContext = context.applicationContext

    CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
      try {
        val repository = AppGraph.repository(appContext)
        if (intent.hasExtra("validationCaptureLimitMs")) {
          SensorServiceController.configureDebugCaptureLimit(intent.getLongExtra("validationCaptureLimitMs", 0L))
          Log.i(TAG, "Debug limit configured for the next service start")
        }
        if (intent.hasExtra("validationImageOnly")) {
          SensorServiceController.configureDebugImageOnly(intent.getBooleanExtra("validationImageOnly", false))
          Log.i(TAG, "Debug image-only policy configured for the next service start")
        }
        if (stopSensing) {
          stopValidationCapture(appContext)
          Log.i(TAG, "Debug sensing stop requested")
          return@launch
        }
        val shouldPair = setupCode.isNotBlank() || (host.isNotBlank() && token.isNotBlank())
        if (shouldPair) {
          val session = if (setupCode.isNotBlank()) {
            repository.pairWithSetupCode(
              setupCode = setupCode,
              deviceName = deviceName,
              appVersion = BuildConfig.VERSION_NAME,
            )
          } else {
            repository.pairManual(
              host = host,
              token = token,
              deviceName = deviceName,
              appVersion = BuildConfig.VERSION_NAME,
            )
          }
          Log.i(TAG, "Debug session repair succeeded. deviceId=${session.deviceId} host=${session.host}")
        }
        if (startSensing) {
          SensorServiceController.start(appContext)
          repository.setServiceEnabled(true)
          Log.i(TAG, "Debug sensing start requested")
          synchronized(leaseLock) {
            validationLease?.cancel()
            validationLease = null
            if (stopAfterMs > 0L) {
              // Finish the broadcast promptly; the running foreground service
              // keeps this bounded test timer alive even if USB disconnects.
              validationLease = CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                delay(stopAfterMs)
                synchronized(leaseLock) {
                  if (validationLease === coroutineContext[Job]) {
                    stopValidationCapture(appContext)
                    Log.i(TAG, "Debug validation capture expired after ${stopAfterMs}ms")
                  }
                }
              }
            }
          }
        }
        if (triggerAssistantQuery) {
          SensorServiceController.triggerAssistantQuery(appContext, modeHint)
          Log.i(TAG, "Debug assistant query requested. modeHint=$modeHint")
        }
        if (stopAssistantSpeaking) {
          SensorServiceController.stopAssistantSpeaking(appContext)
          Log.i(TAG, "Debug assistant stop-speaking requested")
        }
        if (captureVideoClip) {
          SensorServiceController.captureVideoClip(appContext)
          Log.i(TAG, "Debug video capture requested")
        }
        if (injectThrottle) {
          repository.injectDebugCaptureThrottle(
            durationMs = throttleDurationMs,
            queueDepth = throttleQueueDepth,
          )
          val throttle = repository.captureThrottleSnapshot()
          Log.i(
            TAG,
            "Debug throttle injected level=${throttle.level} reason=${throttle.reason} durationMs=$throttleDurationMs queueDepth=$throttleQueueDepth",
          )
        }
      } catch (error: Throwable) {
        Log.e(TAG, "Debug session repair failed", error)
      } finally {
        pendingResult.finish()
      }
    }
  }

  private fun stopValidationCapture(context: Context) {
    synchronized(leaseLock) {
      validationLease?.cancel()
      validationLease = null
      val repository = AppGraph.repository(context)
      repository.setServiceEnabled(false)
      WorkScheduler.cancelHeartbeat(context)
      // Stop the existing service without creating one from a background receiver.
      val stopped = context.stopService(Intent(context, SensorForegroundService::class.java))
      if (!stopped) repository.updateRuntimeStatus(ServiceRuntimeStatus())
    }
  }

  private companion object {
    val leaseLock = Any()
    var validationLease: Job? = null
    const val TAG = "ClawSenseDebugRepair"
    const val EXTRA_SETUP_CODE = "setupCode"
    const val EXTRA_HOST = "host"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_DEVICE_NAME = "deviceName"
    const val EXTRA_START_SENSING = "startSensing"
    const val EXTRA_STOP_SENSING = "stopSensing"
    const val EXTRA_STOP_AFTER_MS = "stopAfterMs"
    const val EXTRA_TRIGGER_ASSISTANT_QUERY = "triggerAssistantQuery"
    const val EXTRA_STOP_ASSISTANT_SPEAKING = "stopAssistantSpeaking"
    const val EXTRA_CAPTURE_VIDEO_CLIP = "captureVideoClip"
    const val EXTRA_ASSISTANT_MODE_HINT = "assistantModeHint"
    const val EXTRA_INJECT_THROTTLE = "injectThrottle"
    const val EXTRA_THROTTLE_DURATION_MS = "throttleDurationMs"
    const val EXTRA_THROTTLE_QUEUE_DEPTH = "throttleQueueDepth"
    const val DEFAULT_THROTTLE_DURATION_MS = 60_000L
    const val DEFAULT_THROTTLE_QUEUE_DEPTH = 24
  }
}
