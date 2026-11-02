package ai.openclaw.clawsense.digital

import ai.openclaw.clawsense.AppGraph
import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class DigitalSyncWorker(context: Context, params: WorkerParameters): CoroutineWorker(context, params) {
  override suspend fun doWork(): Result = try {
    if (AppGraph.digital(applicationContext).sync()) Result.success() else Result.retry()
  } catch (_: Exception) { Result.retry() }

  companion object {
    fun schedule(context: Context) {
      val request = OneTimeWorkRequestBuilder<DigitalSyncWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
      WorkManager.getInstance(context).enqueueUniqueWork("clawsense-digital-sync", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
  }
}
