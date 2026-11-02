package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.MainActivity
import ai.openclaw.clawsense.service.SensorServiceController
import android.os.Debug
import android.os.SystemClock
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlinx.serialization.json.*

/** 30-minute actual Android transport/playback; synthetic text, microphone stays closed. */
class LiveSustainedDeviceTest {
  @Test fun thirtyMinutesOfControlledConversationAndRecovery() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val live = AppGraph.live(context)
    val folder = File(context.filesDir, "live-validation").apply { mkdirs() }
    fun await(timeout: Long = 60000, test: () -> Boolean) { val end = SystemClock.elapsedRealtime() + timeout; while (!test() && SystemClock.elapsedRealtime() < end) Thread.sleep(40); assertTrue("Timed out: ${live.state.value.error}", test()) }
    SensorServiceController.stop(context); live.disconnect(); Thread.sleep(400)
    val inputFrames = live.inputFrames.get()
    val start = SystemClock.elapsedRealtime()
    val rounds = mutableListOf<JsonObject>()
    ActivityScenario.launch(MainActivity::class.java).use { activity ->
      activity.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
      live.connect(); await { live.state.value.connected }
      try {
        var count = 0
        while (SystemClock.elapsedRealtime() - start < 1800000) {
          val before = live.observedTurns.get(); val submitted = SystemClock.elapsedRealtime()
          live.text("小伴，${7 + count % 3}加5是多少？")
          await { live.observedTurns.get() > before && live.state.value.turnCompleted }
          await { !live.state.value.speaking }
          assertNull(live.state.value.error)
          val expected = (12 + count % 3).toString(); assertTrue(live.state.value.answer.contains(expected))
          val memory = Debug.MemoryInfo(); Debug.getMemoryInfo(memory)
          val battery = context.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
          rounds.add(buildJsonObject { put("round", count); put("elapsedMs", SystemClock.elapsedRealtime()-start); put("textToAudioTrackMs", live.firstAudioElapsedMs-submitted); put("appPssKiB", memory.totalPss); put("batteryTemperatureTenthsC", battery?.getIntExtra("temperature", -1) ?: -1); put("charging", battery?.getIntExtra("plugged", 0) != 0) })
          if (count % 10 == 9) { live.disconnect(); Thread.sleep(300); activity.recreate(); activity.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }; live.connect(); await { live.state.value.connected } }
          File(folder, "sustained-progress.json").writeText(buildJsonObject { put("elapsedMs", SystemClock.elapsedRealtime()-start); put("rounds", JsonArray(rounds)); put("actualMicrophone", false) }.toString())
          count++; Thread.sleep(15000)
        }
        assertEquals("Sustained text check opened a microphone", inputFrames, live.inputFrames.get())
        File(folder, "sustained-final.json").writeText(buildJsonObject { put("elapsedMs", SystemClock.elapsedRealtime()-start); put("rounds", JsonArray(rounds)); put("actualAndroidPlayback", true); put("actualMicrophone", false); put("usbCharging", true); put("batteryLifeAccepted", false); put("humanNaturalnessAccepted", false) }.toString())
      } finally { live.disconnect(); SensorServiceController.stop(context) }
    }
  }
}
