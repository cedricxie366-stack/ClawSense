package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.data.AssistantModeHint
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import ai.openclaw.clawsense.BuildConfig
import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.data.ServicePhase
import ai.openclaw.clawsense.work.WorkScheduler
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean

internal fun isPermissionAllowedForCapture(permission: String, granted: Boolean, imageOnly: Boolean): Boolean =
  granted && (!imageOnly || permission != "android.permission.RECORD_AUDIO")

object SensorServiceController {
  private val debugImageOnlyNextStart = AtomicBoolean(false)
  internal fun configureDebugImageOnly(enabled: Boolean) {
    if (BuildConfig.DEBUG) debugImageOnlyNextStart.set(enabled)
  }
  internal fun consumeDebugImageOnly(): Boolean = BuildConfig.DEBUG && debugImageOnlyNextStart.getAndSet(false)
  private val debugCaptureLimitMs = AtomicLong(0L)

  internal fun configureDebugCaptureLimit(durationMs: Long) {
    if (BuildConfig.DEBUG) debugCaptureLimitMs.set(durationMs.coerceIn(0L, 120_000L))
  }

  // Activity-configured validation applies to every subsequent start, including
  // after process death. One-shot in-process limits remain available for tests.
  internal fun configureDebugValidationWindow(context: Context, durationMs: Long) {
    if (!BuildConfig.DEBUG) return
    val preferences = context.getSharedPreferences("capture-validation", Context.MODE_PRIVATE)
    check(preferences.edit().putLong("limitMs", durationMs.coerceIn(0L, 120_000L)).commit()) {
      "Unable to save validation capture limit"
    }
  }

  internal fun consumeDebugCaptureLimit(context: Context): Long {
    if (!BuildConfig.DEBUG) return 0L
    val oneShot = debugCaptureLimitMs.getAndSet(0L)
    val window = context.getSharedPreferences("capture-validation", Context.MODE_PRIVATE).getLong("limitMs", 0L).coerceIn(0L, 120_000L)
    return if (window > 0 && oneShot > 0) minOf(window, oneShot) else maxOf(window, oneShot)
  }

  internal const val ACTION_LIVE_START = "ai.openclaw.clawsense.action.LIVE_START"
  internal const val ACTION_LIVE_STOP = "ai.openclaw.clawsense.action.LIVE_STOP"
  fun startLive(context: Context, native: Boolean = false, visual: Boolean = false) { if (ai.openclaw.clawsense.live.UpstreamLiveActivity.active || AppGraph.repository(context).runtimeStatus.value.phase == ServicePhase.STOPPING) return; ContextCompat.startForegroundService(context, Intent(context, SensorForegroundService::class.java).setAction(ACTION_LIVE_START).putExtra("native", native).putExtra("visual", visual)) }
  fun stopLive(context: Context) {
    AppGraph.live(context).disconnect()
    if (AppGraph.repository(context).runtimeStatus.value.phase in listOf(ServicePhase.STOPPED, ServicePhase.STOPPING)) return
    context.startService(Intent(context, SensorForegroundService::class.java).setAction(ACTION_LIVE_STOP))
  }
  const val CHANNEL_ID = "clawsense_sensor_channel"
  const val NOTIFICATION_ID = 4242
  private const val ACTION_START = "ai.openclaw.clawsense.action.START"
  private const val ACTION_STOP = "ai.openclaw.clawsense.action.STOP"
  private const val ACTION_TRIGGER_ASSISTANT_QUERY = "ai.openclaw.clawsense.action.TRIGGER_ASSISTANT_QUERY"
  private const val ACTION_STOP_ASSISTANT_SPEAKING = "ai.openclaw.clawsense.action.STOP_ASSISTANT_SPEAKING"
  private const val ACTION_CAPTURE_VIDEO_CLIP = "ai.openclaw.clawsense.action.CAPTURE_VIDEO_CLIP"
  private const val EXTRA_ASSISTANT_MODE_HINT = "assistant_mode_hint"

  fun start(context: Context) {
    if (ai.openclaw.clawsense.live.UpstreamLiveActivity.active) return
    if (AppGraph.repository(context).runtimeStatus.value.phase == ServicePhase.STOPPING) return
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_START)
    ContextCompat.startForegroundService(context, intent)
  }

  fun stop(context: Context) {
    ai.openclaw.clawsense.live.UpstreamLiveActivity.stopAll()
    val repository = AppGraph.repository(context)
    repository.setServiceEnabled(false)
    WorkScheduler.cancelHeartbeat(context)
    AppGraph.live(context).disconnect()
    // Stopping must not create a service whose late cleanup closes the next Live.
    context.stopService(Intent(context, SensorForegroundService::class.java))
  }

  fun triggerAssistantQuery(
    context: Context,
    modeHint: AssistantModeHint = AssistantModeHint.AUTO,
  ) {
    val intent = Intent(context, SensorForegroundService::class.java)
      .setAction(ACTION_TRIGGER_ASSISTANT_QUERY)
      .putExtra(EXTRA_ASSISTANT_MODE_HINT, modeHint.name)
    ContextCompat.startForegroundService(context, intent)
  }

  fun stopAssistantSpeaking(context: Context) {
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_STOP_ASSISTANT_SPEAKING)
    ContextCompat.startForegroundService(context, intent)
  }

  fun captureVideoClip(context: Context) {
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_CAPTURE_VIDEO_CLIP)
    ContextCompat.startForegroundService(context, intent)
  }

  internal fun isStopAction(intent: Intent?): Boolean = intent?.action == ACTION_STOP
  internal fun isAssistantQueryAction(intent: Intent?): Boolean = intent?.action == ACTION_TRIGGER_ASSISTANT_QUERY
  internal fun isStopAssistantSpeakingAction(intent: Intent?): Boolean = intent?.action == ACTION_STOP_ASSISTANT_SPEAKING
  internal fun isCaptureVideoClipAction(intent: Intent?): Boolean = intent?.action == ACTION_CAPTURE_VIDEO_CLIP
  internal fun readAssistantModeHint(intent: Intent?): AssistantModeHint {
    val raw = intent?.getStringExtra(EXTRA_ASSISTANT_MODE_HINT)?.trim().orEmpty()
    return runCatching { AssistantModeHint.valueOf(raw) }.getOrDefault(AssistantModeHint.AUTO)
  }
}
