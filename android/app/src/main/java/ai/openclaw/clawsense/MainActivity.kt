package ai.openclaw.clawsense

import ai.openclaw.clawsense.ui.ClawSenseApp
import ai.openclaw.clawsense.ui.ClawSenseTheme
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal data class AppEntry(val id: String = "launcher", val digitalOnly: Boolean = false, val draftId: String? = null, val message: String? = null)

class MainActivity : ComponentActivity() {
  private var entry by mutableStateOf(AppEntry())
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    volumeControlStream = android.media.AudioManager.STREAM_MUSIC
    applyValidationScreenPolicy(intent)
    enableEdgeToEdge()
    entry = readEntry(intent)
    setContent { ClawSenseTheme { ClawSenseApp(entry) } }
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    applyValidationScreenPolicy(intent)
    entry = readEntry(intent)
  }
  private fun applyValidationScreenPolicy(intent: Intent) {
    if (!BuildConfig.DEBUG) return
    if (intent.hasExtra("validationCaptureLimitMs")) {
      ai.openclaw.clawsense.service.SensorServiceController.configureDebugValidationWindow(this, intent.getLongExtra("validationCaptureLimitMs", 0L))
    }
    if (intent.getBooleanExtra("validationKeepScreenOn", false)) {
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    } else {
      window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }
  private fun readEntry(intent: Intent) = AppEntry(
    id = intent.getStringExtra(EXTRA_ENTRY_ID) ?: "launcher",
    digitalOnly = intent.getBooleanExtra(EXTRA_DIGITAL_ENTRY, false),
    draftId = intent.getStringExtra(EXTRA_DRAFT_ID),
    message = intent.getStringExtra(EXTRA_MESSAGE),
  )
  companion object {
    const val EXTRA_DIGITAL_ENTRY = "clawsense.digital_entry"
    const val EXTRA_ENTRY_ID = "clawsense.entry_id"
    const val EXTRA_DRAFT_ID = "clawsense.draft_id"
    const val EXTRA_MESSAGE = "clawsense.entry_message"
  }
}
