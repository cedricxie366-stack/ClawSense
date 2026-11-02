package ai.openclaw.clawsense

import ai.openclaw.clawsense.digital.*
import ai.openclaw.clawsense.ui.ClawSenseTheme
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.UUID

/** Compatibility share entry: consume temporary URI grants before navigating to the app. */
class DigitalActivity : ComponentActivity() {
  private val importer by lazy {
    ViewModelProvider(this, viewModelFactory { initializer { ShareImportViewModel(AppGraph.digital(this@DigitalActivity), createSavedStateHandle()) } })[ShareImportViewModel::class.java]
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    if (savedInstanceState == null) receive(intent)
    setContent {
      val result by importer.completed.collectAsState()
      LaunchedEffect(result?.id) { result?.let { openMemory(it.id, it.ids.singleOrNull(), it.message) } }
      ClawSenseTheme { Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
          CircularProgressIndicator(); Spacer(Modifier.height(20.dp)); Text("正在保存到本机…")
        }
      } }
    }
  }
  override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receive(intent) }
  @Suppress("DEPRECATION")
  private fun receive(incoming: Intent) {
    if (incoming.action !in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) { openMemory(UUID.randomUUID().toString(), null, null); return }
    val uris = if (incoming.action == Intent.ACTION_SEND_MULTIPLE) incoming.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty() else listOfNotNull(incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    importer.enqueue(ShareBatch(mime = incoming.type.orEmpty(), text = incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(), title = incoming.getStringExtra(Intent.EXTRA_SUBJECT) ?: "分享的文字", uris = uris.map { it.toString() }))
  }
  private fun openMemory(id: String, draftId: String?, message: String?) {
    startActivity(Intent(this, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(MainActivity.EXTRA_DIGITAL_ENTRY, true); putExtra(MainActivity.EXTRA_ENTRY_ID, id)
      putExtra(MainActivity.EXTRA_DRAFT_ID, draftId); putExtra(MainActivity.EXTRA_MESSAGE, message)
    })
    finish()
  }
}
