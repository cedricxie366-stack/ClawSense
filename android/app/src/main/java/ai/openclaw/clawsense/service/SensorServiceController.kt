package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.data.AssistantModeHint
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

object SensorServiceController {
  const val CHANNEL_ID = "clawsense_sensor_channel"
  const val NOTIFICATION_ID = 4242
  private const val ACTION_START = "ai.openclaw.clawsense.action.START"
  private const val ACTION_STOP = "ai.openclaw.clawsense.action.STOP"
  private const val ACTION_TRIGGER_ASSISTANT_QUERY = "ai.openclaw.clawsense.action.TRIGGER_ASSISTANT_QUERY"
  private const val ACTION_STOP_ASSISTANT_SPEAKING = "ai.openclaw.clawsense.action.STOP_ASSISTANT_SPEAKING"
  private const val ACTION_CAPTURE_VIDEO_CLIP = "ai.openclaw.clawsense.action.CAPTURE_VIDEO_CLIP"
  private const val EXTRA_ASSISTANT_MODE_HINT = "assistant_mode_hint"

  fun start(context: Context) {
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_START)
    ContextCompat.startForegroundService(context, intent)
  }

  fun stop(context: Context) {
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_STOP)
    context.startService(intent)
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
