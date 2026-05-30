package ai.openclaw.clawsense.debug

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.BuildConfig
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class DebugSessionRepairReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pendingResult = goAsync()
    val setupCode = intent.getStringExtra(EXTRA_SETUP_CODE)?.trim().orEmpty()
    val host = intent.getStringExtra(EXTRA_HOST)?.trim().orEmpty()
    val token = intent.getStringExtra(EXTRA_TOKEN)?.trim().orEmpty()
    val deviceName = intent.getStringExtra(EXTRA_DEVICE_NAME)?.trim()
      ?: Build.MODEL.ifBlank { "ClawSense Android" }

    CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
      try {
        val repository = AppGraph.repository(context.applicationContext)
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
      } catch (error: Throwable) {
        Log.e(TAG, "Debug session repair failed", error)
      } finally {
        pendingResult.finish()
      }
    }
  }

  private companion object {
    const val TAG = "ClawSenseDebugRepair"
    const val EXTRA_SETUP_CODE = "setupCode"
    const val EXTRA_HOST = "host"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_DEVICE_NAME = "deviceName"
  }
}
