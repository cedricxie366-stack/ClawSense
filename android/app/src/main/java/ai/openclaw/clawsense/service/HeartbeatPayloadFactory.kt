package ai.openclaw.clawsense.service

import ai.openclaw.clawsense.data.HeartbeatRequest
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager

object HeartbeatPayloadFactory {
  fun create(
    context: Context,
    appState: String,
    heartbeatIntervalSec: Int,
  ): HeartbeatRequest {
    val batteryManager = context.getSystemService(BatteryManager::class.java)
    val level = batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.toDouble()
    val cm = context.getSystemService(ConnectivityManager::class.java)
    val capabilities = cm?.getNetworkCapabilities(cm.activeNetwork)
    val network = when {
      capabilities == null -> "offline"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      else -> "other"
    }
    return HeartbeatRequest(
      batteryPct = level?.takeIf { it >= 0 },
      network = network,
      appState = "$appState:$heartbeatIntervalSec",
    )
  }
}
