package ai.openclaw.clawsense

import ai.openclaw.clawsense.service.SensorServiceController
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class ClawSenseApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    AppGraph.initialize(this)
    createNotificationChannel()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val channel = NotificationChannel(
      SensorServiceController.CHANNEL_ID,
      getString(R.string.notification_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.notification_channel_desc)
      setShowBadge(false)
    }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(channel)
  }
}
