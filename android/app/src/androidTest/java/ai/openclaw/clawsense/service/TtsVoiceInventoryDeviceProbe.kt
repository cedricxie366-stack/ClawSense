package ai.openclaw.clawsense.service

import android.speech.tts.TextToSpeech
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Metadata probe only: no utterance, microphone, camera, or product-quality verdict. */
@RunWith(AndroidJUnit4::class)
class TtsVoiceInventoryDeviceProbe {
  @Test fun saveChineseVoiceMetadataWithoutPlayback() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val initialized = CompletableDeferred<Int>()
    val engine = withContext(Dispatchers.Main) { TextToSpeech(context) { initialized.complete(it) } }
    try {
      assertEquals(TextToSpeech.SUCCESS, withTimeout(15000) { initialized.await() })
      val report = withContext(Dispatchers.Main) {
        val languageStatus = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
        val voices = (engine.voices ?: emptySet()).filter { it.locale.language in listOf("zh", "zho") }.sortedBy { it.name }
        JSONObject().put("metadataOnly", true).put("playbackStarted", false)
          .put("defaultEngine", engine.defaultEngine)
          .put("languageStatus", languageStatus)
          .put("selectedVoice", engine.voice?.name ?: JSONObject.NULL)
          .put("engines", JSONArray(engine.engines.map { JSONObject().put("name", it.name).put("label", it.label) }))
          .put("chineseVoices", JSONArray(voices.map {
            JSONObject().put("name", it.name).put("locale", it.locale.toLanguageTag())
              .put("quality", it.quality).put("latency", it.latency)
              .put("networkRequiredReported", it.isNetworkConnectionRequired)
          }))
      }
      File(context.filesDir, "tts-voice-inventory-validation.json").writeText(report.toString(2))
      println("CLAWSENSE_TTS_VOICE_INVENTORY=" + report.toString())
    } finally { withContext(Dispatchers.Main) { engine.shutdown() } }
  }
}
