package ai.openclaw.clawsense.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object WorkScheduler {
  private const val HEARTBEAT_WORK_NAME = "clawsense-heartbeat"

  fun scheduleHeartbeat(context: Context) {
    val request = PeriodicWorkRequestBuilder<SessionHeartbeatWorker>(15, TimeUnit.MINUTES)
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build(),
      )
      .build()
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      HEARTBEAT_WORK_NAME,
      ExistingPeriodicWorkPolicy.UPDATE,
      request,
    )
  }

  fun cancelHeartbeat(context: Context) {
    WorkManager.getInstance(context).cancelUniqueWork(HEARTBEAT_WORK_NAME)
  }
}
