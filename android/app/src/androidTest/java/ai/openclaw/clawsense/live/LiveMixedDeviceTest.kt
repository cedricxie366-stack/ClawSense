package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.MainActivity
import ai.openclaw.clawsense.data.CapturedImageFrame
import ai.openclaw.clawsense.data.ServicePhase
import ai.openclaw.clawsense.service.SensorServiceController
import android.os.Debug
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Real-duration mixed model/Android exercise; input files are synthetic, no microphone. */
class LiveMixedDeviceTest {
  @Test fun thirtyMinutesOfMixedInputPlaybackAndRecovery() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val live = AppGraph.live(context)
    val repo = AppGraph.repository(context)
    val folder = File(context.filesDir, "live-validation").apply { mkdirs() }
    val image = File(folder, "mixed-shapes.jpg").readBytes()
    val question = File(folder, "question.pcm").readBytes()
    val stop = File(folder, "stop.pcm").readBytes()
    val duration = InstrumentationRegistry.getArguments().getString("durationMs", "1800000").toLong()
    require(duration in 10_000L..7_200_000L)
    val rows = mutableListOf<JsonObject>()
    val inputLock = Any()
    var injectingPcm = false
    val feeding = java.util.concurrent.atomic.AtomicBoolean(true)
    val silence = ByteArray(640)
    val silenceFeeder = Thread {
      try {
        while (feeding.get()) {
          synchronized(inputLock) { if (!injectingPcm) live.feed(silence) }
          Thread.sleep(20)
        }
      } catch (_: InterruptedException) { /* Controlled test shutdown. */ }
    }
    val startedAt = System.currentTimeMillis()
    for (name in listOf("mixed-progress", "mixed-final", "mixed-last-state")) File(folder, "$name.json").delete()
    fun await(timeout: Long = 90_000L, condition: () -> Boolean) {
      val until = SystemClock.elapsedRealtime() + timeout
      while (!condition() && SystemClock.elapsedRealtime() < until) Thread.sleep(40)
      assertTrue("Timed out: ${live.state.value.error}", condition())
    }
    fun feed(pcm: ByteArray) {
      synchronized(inputLock) { injectingPcm = true }
      try {
        var offset = 0
        while (offset < pcm.size) { live.feed(pcm.copyOfRange(offset, minOf(offset + 640, pcm.size))); offset += 640; Thread.sleep(20) }
        repeat(60) { live.feed(silence); Thread.sleep(20) }
      } finally { synchronized(inputLock) { injectingPcm = false } }
    }
    fun finishTurn(before: Long) {
      await { live.state.value.error != null || (live.observedTurns.get() > before && live.state.value.turnCompleted) }
      assertNull(live.state.value.error)
      await(3000) { live.firstAudioElapsedMs > 0 || live.state.value.error != null }
      assertNull(live.state.value.error); await { !live.state.value.speaking }
    }
    fun save(name: String, elapsed: Long, complete: Boolean) {
      File(folder, "$name.json").writeText(buildJsonObject {
        put("elapsedMs", elapsed); put("requestedDurationMs", duration); put("complete", complete)
        put("startedAt", startedAt)
        put("connected", live.state.value.connected)
        put("error", live.state.value.error?.let(::JsonPrimitive) ?: JsonNull)
        put("diagnosticCode", live.state.value.diagnosticCode?.let(::JsonPrimitive) ?: JsonNull)
        if (live.state.value.inputDiagnosticsJson.isNotBlank()) put("inputDiagnostics", Json.parseToJsonElement(live.state.value.inputDiagnosticsJson))
        put("rounds", JsonArray(rows)); put("input", "continuous synthetic silence, spoken PCM, text and JPEG")
        put("continuousSyntheticAudio", true); put("inputFrames", live.inputFrames.get())
        put("actualMicrophone", false); put("actualPhysicalCamera", false)
        put("humanNaturalnessAccepted", false); put("batteryLifeAccepted", false)
      }.toString())
    }
    SensorServiceController.stop(context); live.disconnect(); Thread.sleep(400)
    val initialFrames = live.inputFrames.get()
    ActivityScenario.launch(MainActivity::class.java).use { activity ->
      activity.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
      live.setVisualEnabled(true)
      live.captureFrame = { CapturedImageFrame(image, capturedAt = System.currentTimeMillis(), note = "synthetic shape fixture") }
      val start = SystemClock.elapsedRealtime()
      try {
        silenceFeeder.start()
        live.connect(); await { live.state.value.connected }
        var before = live.observedTurns.get()
        live.text("这是合成测试。小陈希望周四收到方案，预算三万元。明天下午三点开会。请简短确认。")
        finishTurn(before)
        var count = 0
        while (SystemClock.elapsedRealtime() - start < duration) {
          val kind = count % 6
          before = live.observedTurns.get(); val submitted = SystemClock.elapsedRealtime()
          when (kind) {
            0 -> live.text("小伴，为什么天空是蓝色的？")
            1 -> live.text("请简短复述小陈的收方案日期、预算和会议时间。")
            2 -> feed(question)
            3 -> live.text("把这句话翻译成英语：谢谢你今天的帮助。")
            4 -> live.text("我现在在看什么？请说出画面的主要颜色和形状。")
            else -> live.text("七加五是多少？")
          }
          finishTurn(before)
          assertTrue("This turn did not reach AudioTrack", live.firstAudioElapsedMs >= submitted)
          val answer = live.state.value.answer
          when (kind) {
            0 -> assertTrue("Wrong science: $answer", answer.contains("散射"))
            // The question already names 小陈; a natural reply may omit that subject.
            // Check all promised facts instead. Explicit recipient questions are
            // covered separately in the ten-turn conversation test.
            1 -> assertTrue("Lost memory facts: $answer", (answer.contains("周四") || answer.contains("星期四")) && Regex("三万|3万|30000|30,000").containsMatchIn(answer) && answer.contains("明天") && (answer.contains("下午三点") || answer.contains("下午3点") || answer.contains("15:00")))
            2 -> assertTrue("Lost voice question: $answer", answer.contains("周四"))
            3 -> assertTrue("Wrong translation: $answer", answer.contains("thank", true) && answer.contains("help", true))
            4 -> assertTrue("Missing known fixture colors: $answer", Regex("红|蓝").findAll(answer).map { it.value }.toSet().size == 2)
            else -> assertTrue("Wrong arithmetic: $answer", answer.contains("12") || answer.contains("十二"))
          }
          assertEquals("Controlled input opened a microphone", ServicePhase.STOPPED, repo.runtimeStatus.value.phase)
          val memory = Debug.MemoryInfo(); Debug.getMemoryInfo(memory)
          rows.add(buildJsonObject {
            put("round", count); put("kind", kind); put("elapsedMs", SystemClock.elapsedRealtime() - start)
            put("answer", answer); put("textOrPcmStartToAudioTrackMs", live.firstAudioElapsedMs - submitted)
            put("firstPacketToAudioTrackMs", live.firstAudioElapsedMs - live.firstAudioReceivedElapsedMs)
            put("appPssKiB", memory.totalPss)
            if (live.state.value.hostTimingsJson.isNotBlank()) put("host", Json.parseToJsonElement(live.state.value.hostTimingsJson))
          })
          if (count % 12 == 11) {
            before = live.observedTurns.get(); live.text("请详细说明见客户前的准备事项。")
            await { live.observedTurns.get() > before && live.state.value.speaking }
            feed(stop); await { !live.state.value.speaking && live.state.value.transcript.contains("停") }
            val writes = live.audioWrites.get(); Thread.sleep(800); assertEquals("Stopped audio resumed", writes, live.audioWrites.get())
            live.disconnect(); Thread.sleep(300); activity.recreate()
            activity.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            live.connect(); await { live.state.value.connected }
          }
          count++; save("mixed-progress", SystemClock.elapsedRealtime() - start, false)
          Thread.sleep(minOf(10_000L, maxOf(0L, duration - (SystemClock.elapsedRealtime() - start))))
        }
        assertTrue(live.inputFrames.get() > initialFrames)
        save("mixed-final", SystemClock.elapsedRealtime() - start, true)
      } finally {
        save("mixed-last-state", SystemClock.elapsedRealtime() - start, false)
        feeding.set(false); silenceFeeder.interrupt(); silenceFeeder.join(1000)
        live.captureFrame = null; live.setVisualEnabled(false); live.disconnect(); SensorServiceController.stop(context)
      }
    }
  }
}
