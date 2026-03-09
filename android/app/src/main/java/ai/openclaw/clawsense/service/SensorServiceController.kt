package ai.openclaw.clawsense.service

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

object SensorServiceController {
  const val CHANNEL_ID = "clawsense_sensor_channel"
  const val NOTIFICATION_ID = 4242
  private const val ACTION_START = "ai.openclaw.clawsense.action.START"
  private const val ACTION_STOP = "ai.openclaw.clawsense.action.STOP"

  fun start(context: Context) {
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_START)
    ContextCompat.startForegroundService(context, intent)
  }

  fun stop(context: Context) {
    val intent = Intent(context, SensorForegroundService::class.java).setAction(ACTION_STOP)
    context.startService(intent)
  }

  internal fun isStopAction(intent: Intent?): Boolean = intent?.action == ACTION_STOP
}
