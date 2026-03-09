package ai.openclaw.clawsense.work

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.service.HeartbeatPayloadFactory
import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class SessionHeartbeatWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val repository = AppGraph.repository(applicationContext)
    repository.refresh()
    if (!repository.serviceEnabled.value) {
      return Result.success()
    }
    val session = repository.session.value ?: return Result.success()
    return runCatching {
      repository.sendHeartbeat(
        HeartbeatPayloadFactory.create(
          context = applicationContext,
          appState = "worker",
          heartbeatIntervalSec = session.heartbeatIntervalSec,
        ),
      )
      Result.success()
    }.getOrElse { Result.retry() }
  }
}
