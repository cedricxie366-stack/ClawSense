package ai.openclaw.clawsense.work

import ai.openclaw.clawsense.AppGraph
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootCompletedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
      return
    }
    val repository = AppGraph.repository(context)
    repository.refresh()
    if (repository.session.value != null && repository.serviceEnabled.value) {
      WorkScheduler.scheduleHeartbeat(context)
    }
  }
}
