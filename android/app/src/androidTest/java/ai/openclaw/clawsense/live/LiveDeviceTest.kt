package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.MainActivity
import ai.openclaw.clawsense.service.SensorServiceController
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import android.media.AudioTrack
import android.os.SystemClock
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Controlled device checks; synthesized PCM is separately labeled from microphone input. */
class LiveDeviceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private val controller get() = AppGraph.live(context)
  private val directory get() = File(context.filesDir, "live-validation").apply { mkdirs() }
  private fun await(timeout: Long = 60_000, condition: () -> Boolean) {
    val until = SystemClock.elapsedRealtime() + timeout
    while (!condition() && SystemClock.elapsedRealtime() < until) Thread.sleep(40)
    assertTrue("Timed out: ${controller.state.value.error}; ${controller.state.value.diagnosticCode}", condition())
  }
  private fun pair() = runBlocking {
    val file = File(directory, "setup-code")
    if (!file.exists() && AppGraph.repository(context).session.value != null) return@runBlocking
    val code = file.readText().trim()
    AppGraph.repository(context).pairWithSetupCode(code, "Controlled Live device validation", "live-integration-device")
    file.delete()
  }
  private fun report(name: String, value: JsonObject) { File(directory, "$name.json").writeText(value.toString()) }
  private fun prepareLiveOnly() {
    AppGraph.repository(context).setServiceEnabled(false)
    controller.disconnect()
    SensorServiceController.stop(context)
    await { AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
    Thread.sleep(500)
  }
  @Test fun preparationDoesNotOpenSensorsAndMakesEntryReusable() {
    val intent=android.content.Intent(context,MainActivity::class.java).putExtra("validationKeepScreenOn",true)
    ActivityScenario.launch<MainActivity>(intent).use {
      pair()
      prepareLiveOnly()
      val before=controller.inputFrames.get()
      try {
        controller.prepare()
        await { controller.lastPreparationMs > 0 && !controller.state.value.backgroundPreparing }
        val prepared=controller.lastPreparationMs
        assertFalse(controller.state.value.connected)
        assertEquals(before,controller.inputFrames.get())
        controller.connect(); await { controller.state.value.connected }
      assertEquals(before,controller.inputFrames.get())
      report("preparation-entry",buildJsonObject{
        put("preparationMs",prepared);put("entryMs",controller.lastConnectionMs);put("microphoneFrames",controller.inputFrames.get()-before)
        put("hostPreparation",controller.lastPreparationDetails)
        put("cameraStarted",false);put("foregroundActivity",true)
      })
      } finally {controller.disconnect()}
    }
  }

  @Test fun liveOnlyMicrophoneUsesTwentyMillisecondPacketsWithoutSavingOrSending() = runBlocking {
    prepareLiveOnly()
    val hal=ai.openclaw.clawsense.sensors.AndroidAudioSensorHal(context)
    val sizes=java.util.Collections.synchronizedList(mutableListOf<Int>())
    val times=java.util.Collections.synchronizedList(mutableListOf<Long>())
    ActivityScenario.launch(MainActivity::class.java).use {
      hal.setLiveConsumer({ bytes -> sizes.add(bytes.size);times.add(SystemClock.elapsedRealtime()) },recordAmbient=false)
      try {
        hal.start { error("Live-only check must not create ambient clips") }
        kotlinx.coroutines.delay(1800)
      } finally { hal.stop();hal.setLiveConsumer(null) }
    }
    val captured=sizes.toList()
    assertTrue("Too few actual recorder frames",captured.size>=50)
    assertTrue("Recorder still batches more than 20ms",captured.all { it>0 && it<=640 })
    val count=captured.size;kotlinx.coroutines.delay(200);assertEquals(count,sizes.size)
    report("recorder-packets",buildJsonObject{
      put("frames",count);put("maxPacketMs",captured.max()/32.0);put("totalAudioMs",captured.sum()/32.0)
      put("audioStored",false);put("audioSentToModel",false);put("released",true)
    })
  }

  @Test fun generatedStopPausesActualPlayerAndDoesNotResume() {
    val pcm=File(directory,"stop.pcm").readBytes()
    require(pcm.isNotEmpty() && pcm.size % 2 == 0) { "Missing generated stop fixture" }
    val rows=mutableListOf<JsonObject>()
    var finished=false
    fun feed(bytes:ByteArray): Long {
      var offset=0
      val captureStart=SystemClock.elapsedRealtime()
      while(offset<bytes.size) {
        val end=minOf(offset+640,bytes.size)
        // Pace against the audio clock, not sleep + cumulative processing time.
        val wait=captureStart+end/32-SystemClock.elapsedRealtime()
        if(wait>0) Thread.sleep(wait)
        controller.feed(bytes.copyOfRange(offset,end));offset=end
      }
      return SystemClock.elapsedRealtime()-captureStart
    }
    val intent=android.content.Intent(context,MainActivity::class.java).putExtra("validationKeepScreenOn",true)
    ActivityScenario.launch<MainActivity>(intent).use {
      pair();prepareLiveOnly()
      controller.muteValidationPlayback(true)
      try {
        controller.connect();await {controller.state.value.connected}
        val rounds=InstrumentationRegistry.getArguments().getString("stopRounds")?.toIntOrNull()?.coerceIn(3,20) ?: 3
        repeat(rounds) { round ->
          val writes=controller.audioWrites.get()
          controller.text("请分三句话解释火山为什么喷发。")
          await {controller.audioWrites.get()>writes && controller.state.value.speaking}
          feed(ByteArray(12800))
          val began=SystemClock.elapsedRealtime()
          val feedMs=feed(pcm)
          // A real recorder continues supplying silence after the spoken word.
          // Waiting without tail frames can prevent endpoint detection entirely.
          feed(ByteArray(28800))
          await(2000) {controller.lastStopElapsedMs>=began && (controller.state.value.notice?.contains("已停止说话")==true || controller.state.value.notice?.contains("已暂停")==true)}
          val stops=controller.playbackStopsAfter(began)
          val pauseMs=(stops.mapNotNull{it.pauseCompletedMs}.minOrNull() ?: error("No native pause observed"))-began
          val cleanupMs=stops.minOf{it.completedMs}-began
          val stoppedWrites=controller.audioWrites.get()
          feed(ByteArray(16000))
          assertEquals("Old sound resumed",stoppedWrites,controller.audioWrites.get())
          assertFalse(controller.state.value.speaking)
          rows.add(buildJsonObject{
            put("round",round+1);put("captureStartToPlayerPauseMs",pauseMs);put("oldAudioResumed",false)
            put("captureStartToStopCompletedMs",cleanupMs);put("nominalPcmMs",pcm.size/32);put("actualFeedMs",feedMs)
            put("notice",controller.state.value.notice);put("transcript",controller.state.value.transcript)
            put("stops",JsonArray(controller.playbackStopsAfter(began).map { sample -> buildJsonObject {
              put("arrivalMs",sample.requestedMs-began);put("completeMs",sample.completedMs-began)
              put("pauseCompletedMs",sample.pauseCompletedMs?.minus(began))
              put("gateWaitMs",sample.gateWaitMs);put("pauseMs",sample.pauseMs);put("flushMs",sample.flushMs)
            }}))
          })
        }
        val turns=controller.observedTurns.get();controller.text("六加八是多少？")
        await {controller.observedTurns.get()>turns && controller.state.value.turnCompleted}
        assertTrue(controller.state.value.answer.contains("14"))
        await { !controller.state.value.speaking && controller.playbackProgressSnapshot().let { it.writtenFrames > 0 && it.drained } }
        finished=true
      } finally {
        report("generated-stop-player",buildJsonObject{
          put("source","generated PCM through phone transport, actual ASR and AudioTrack; no physical microphone")
          put("rounds",JsonArray(rows));put("newQuestionAnswered14",finished);put("humanStopAccepted",false)
          put("completed",finished);put("error",controller.state.value.error);put("notice",controller.state.value.notice)
          put("outputMuted",true)
          put("socketDefaultNoDelay",controller.socketDefaultNoDelay);put("socketNoDelayEnabled",controller.socketNoDelayEnabled)
        })
        controller.disconnect()
        controller.muteValidationPlayback(false)
      }
    }
  }

  @Test fun fullReplyDrainsWithoutInjectedStopOrMicrophone() {
    val intent=android.content.Intent(context,MainActivity::class.java).putExtra("validationKeepScreenOn",true)
    ActivityScenario.launch<MainActivity>(intent).use {
      pair();prepareLiveOnly();controller.muteValidationPlayback(true)
      val input=controller.inputFrames.get()
      try {
        controller.connect();await {controller.state.value.connected}
        val before=controller.observedTurns.get()
        val began=SystemClock.elapsedRealtime()
        controller.text("请完整朗读这句话：会议安排在明天下午四点，预算五万元，方案周六交付。")
        await {controller.observedTurns.get()>before && controller.state.value.turnCompleted}
        val generated=SystemClock.elapsedRealtime()
        await { !controller.state.value.speaking && controller.lastPlaybackCompletedElapsedMs>=began && controller.playbackProgressSnapshot().let { it.writtenFrames>0 && it.drained } }
        val progress=controller.playbackProgressSnapshot()
        assertEquals(input,controller.inputFrames.get())
        assertNull(controller.state.value.error)
        report("full-reply-drained",buildJsonObject {
          put("source","actual local generation and muted AudioTrack; no injected stop or microphone")
          put("answer",controller.state.value.answer);put("writtenFrames",progress.writtenFrames);put("playedFrames",progress.playedFrames)
          put("firstAudioMs",controller.firstAudioElapsedMs-began);put("generationCompletedMs",generated-began)
          put("playbackCompletedMs",controller.lastPlaybackCompletedElapsedMs-began);put("microphoneFrames",controller.inputFrames.get()-input)
          put("outputMuted",true);put("humanListeningAccepted",false)
        })
      } finally {controller.disconnect();controller.muteValidationPlayback(false)}
    }
  }

  @Test fun normalConversationDrainsAcrossTopicsAndQuotedText() {
    val cases = listOf(
      "测试客户小叶：周三下午两点开会，预算六万元，方案周五交付。请复述安排。" to listOf("周三", "两点|二点|2点", "六万|6万", "周五"),
      "刚才的客户叫什么？" to listOf("小叶"),
      "更正小叶的安排：会议改为周四下午三点，预算改为八万元。请用一句话汇总最新安排。" to listOf("周四", "三点|3点", "八万|8万"),
      "为什么树叶一般是绿色的？请用两句话解释。" to listOf("叶绿素", "绿"),
      "把谢谢你今天的帮助翻译成英语。" to listOf("thank", "help"),
      "现在小叶的预算是多少？" to listOf("八万|8万"),
      "请原样朗读：测试订单金额为1,234.50元，约在16:30核对。" to listOf("1,?234(?:\\.50?)?|一千二百三十四", "16[:：]30|十六点三十分|下午四点半"),
      "请原样朗读这句英语：Please send the revised proposal before Friday afternoon and confirm the meeting time with the customer." to listOf("revised proposal", "Friday", "customer"),
      "读全文" to listOf("revised proposal", "Friday", "customer"),
      "用两句话汇总小叶最新的会议、预算和方案交付安排。" to listOf("小叶", "周四", "三点|3点", "八万|8万", "周五"),
      "请原样朗读：客户小叶的预算是十万元。" to listOf("小叶", "十万|10万"),
      "朗读材料不算，小叶的实际预算现在是多少？" to listOf("八万|8万"),
    )
    val rows=mutableListOf<JsonObject>()
    val output=File(directory,"normal-dialogue").apply { mkdirs() }
    var completed=false
    var activeQuestion=""
    val intent=android.content.Intent(context,MainActivity::class.java).putExtra("validationKeepScreenOn",true)
    ActivityScenario.launch<MainActivity>(intent).use {
      pair();prepareLiveOnly();controller.muteValidationPlayback(true)
      val input=controller.inputFrames.get()
      try {
        controller.connect();await {controller.state.value.connected}
        for ((index,case) in cases.withIndex()) {
          val bytes=java.io.ByteArrayOutputStream()
          val lock=Any();var rate=0;var packets=0
          controller.observeValidationAudio { chunk,sampleRate -> synchronized(lock) {
            check(rate==0 || rate==sampleRate);rate=sampleRate
            check(bytes.size()+chunk.size<=8*1024*1024)
            bytes.write(chunk);packets++
          } }
          activeQuestion=case.first
          val turns=controller.observedTurns.get();val began=SystemClock.elapsedRealtime()
          var generatedAt=0L;var gapAt=0L;var gapWritten=0L
          val gaps=mutableListOf<Long>()
          controller.text(case.first)
          await(120_000) {
            check(controller.state.value.error==null) { controller.state.value.error.orEmpty() }
            val progress=controller.playbackProgressSnapshot();val now=SystemClock.elapsedRealtime()
            if (controller.observedTurns.get()>turns && controller.state.value.turnCompleted && generatedAt==0L) generatedAt=now
            if (gapAt>0 && progress.writtenFrames>gapWritten) { gaps.add(now-gapAt);gapAt=0 }
            if (controller.observedTurns.get()>turns && controller.firstAudioElapsedMs>=began && progress.writtenFrames>0 && progress.drained && generatedAt==0L && gapAt==0L) { gapAt=now;gapWritten=progress.writtenFrames }
            controller.observedTurns.get()>turns && controller.state.value.turnCompleted && !controller.state.value.speaking &&
              controller.lastPlaybackCompletedElapsedMs>=began && progress.writtenFrames>0 && progress.drained
          }
          controller.observeValidationAudio(null)
          val pcm=synchronized(lock) { bytes.toByteArray() }
          val progress=controller.playbackProgressSnapshot()
          val answer=controller.state.value.answer
          val semantic=case.second.all { Regex(it,RegexOption.IGNORE_CASE).containsMatchIn(answer) }
          val full=pcm.size/2L==progress.writtenFrames && progress.drained && controller.state.value.notice?.contains("声音暂时不可用")!=true
          val sha=java.security.MessageDigest.getInstance("SHA-256").digest(pcm).joinToString("") { "%02x".format(it.toInt() and 255) }
          val head=java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
          head.put("RIFF".toByteArray()).putInt(pcm.size+36).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
            .putInt(rate).putInt(rate*2).putShort(2).putShort(16).put("data".toByteArray()).putInt(pcm.size)
          val name="turn-${index+1}.wav"
          File(output,name).outputStream().use { file -> file.write(head.array());file.write(pcm) }
          val repeated=index!=8 || answer==rows[7]["answer"]!!.jsonPrimitive.content
          rows.add(buildJsonObject {
            put("turn",index+1);put("query",case.first);put("answer",answer);put("semanticMarkersPassed",semantic);put("repeatTextMatches",repeated)
            put("receivedFrames",pcm.size/2);put("writtenFrames",progress.writtenFrames);put("playedFrames",progress.playedFrames)
            put("sampleRate",rate);put("packets",packets);put("audioFile",name);put("pcmSha256",sha);put("fullPlayback",full)
            put("firstAudioMs",controller.firstAudioElapsedMs-began);put("generationCompletedMs",generatedAt-began)
            put("playbackCompletedMs",controller.lastPlaybackCompletedElapsedMs-began);put("maxObservedStarvationMs",gaps.maxOrNull() ?: 0)
            put("hostTimings",controller.state.value.hostTimingsJson);put("notice",controller.state.value.notice)
          })
          report("normal-dialogue",buildJsonObject { put("rows",JsonArray(rows));put("completed",false);put("outputMuted",true) })
          assertTrue("Audio was dropped before full playback on turn ${index+1}",full)
          val stable=controller.observedTurns.get();Thread.sleep(250);assertEquals("Unsolicited new response",stable,controller.observedTurns.get())
        }
        assertEquals(input,controller.inputFrames.get())
        completed=rows.all { it["semanticMarkersPassed"]!!.jsonPrimitive.boolean && it["repeatTextMatches"]!!.jsonPrimitive.boolean }
        assertTrue("Conversation content failed; inspect the per-turn report",completed)
      } finally {
        controller.observeValidationAudio(null)
        report("normal-dialogue",buildJsonObject {
          put("source","typed conversation, actual local models, captured received PCM and muted phone playback; no microphone")
          put("rows",JsonArray(rows));put("completed",completed);put("activeQuestion",activeQuestion)
          put("microphoneFrames",controller.inputFrames.get()-input);put("outputMuted",true);put("humanNaturalnessAccepted",false)
          put("error",controller.state.value.error)
        })
        controller.disconnect();controller.muteValidationPlayback(false)
      }
    }
  }

  @Test fun spokenViewVariantRequestsOneRealFrameWithoutMicrophone() = runBlocking {
    pair(); prepareLiveOnly()
    val before = controller.inputFrames.get()
    val camera = ai.openclaw.clawsense.sensors.CameraXImageSensorHal(context)
    var captures = 0
    val intent = android.content.Intent(context, MainActivity::class.java).putExtra("validationKeepScreenOn", true)
    ActivityScenario.launch<MainActivity>(intent).use {
      try {
        camera.start()
        controller.setVisualEnabled(true)
        controller.captureFrame = {
          camera.captureStill().also { frame ->
            captures++
            File(directory, "spoken-view-frame.jpg").writeBytes(frame.bytes)
          }
        }
        controller.connect(); await { controller.state.value.connected }
        val askedAt=SystemClock.elapsedRealtime()
        controller.text("请问我现在正在看的是是什么？")
        await { controller.state.value.turnCompleted || controller.state.value.error != null }
        assertNull(controller.state.value.error)
        assertTrue(controller.state.value.visualDescription.isNotBlank())
        assertEquals(controller.state.value.visualDescription, controller.state.value.answer)
        assertTrue("No new phone audio write for this image",controller.firstAudioElapsedMs>=askedAt)
        assertEquals(1, captures)
        assertEquals(before, controller.inputFrames.get())
        report("spoken-view-frame", buildJsonObject {
          put("captureCount", captures); put("microphoneFrames", controller.inputFrames.get() - before)
          put("answer", controller.state.value.answer); put("hostTimingsJson", controller.state.value.hostTimingsJson)
          put("textToPhoneWriteMs",controller.firstAudioElapsedMs-askedAt)
          put("visualConnectionMs",controller.lastConnectionMs)
          put("source", "typed natural speech variant; actual camera, local vision and phone playback")
        })
      } finally {
        controller.captureFrame = null; controller.setVisualEnabled(false); controller.disconnect(); camera.stop()
      }
    }
  }

  @Test fun audienceSettingsSaveBeforeStartingMicrophone() {
    pair(); prepareLiveOnly()
    val frames = controller.inputFrames.get()
    controller.prepare(); await { controller.state.value.personaJson.isNotBlank() }
    val original = Json.parseToJsonElement(controller.state.value.personaJson).jsonObject
    try {
      controller.setPersona(JsonObject(original + ("publicScene" to JsonPrimitive(true))).toString())
      await { !controller.state.value.configuring && Json.parseToJsonElement(controller.state.value.personaJson).jsonObject["publicScene"]?.jsonPrimitive?.boolean == true }
      controller.prepare(); Thread.sleep(500)
      assertTrue(Json.parseToJsonElement(controller.state.value.personaJson).jsonObject["publicScene"]!!.jsonPrimitive.boolean)
      assertEquals("Loading/saving settings opened a microphone", frames, controller.inputFrames.get())
      assertFalse(controller.state.value.connected)
      controller.connect(); await { controller.state.value.connected }
      val turns = controller.observedTurns.get()
      controller.text("用更强模型查询资料")
      await { controller.state.value.error?.contains("公开场景当前支持本地回答") == true }
      assertEquals("Public mode dispatched private-capable work", turns, controller.observedTurns.get())
      report("prestart-settings", buildJsonObject { put("publicModeSavedBeforeMicrophone", true); put("microphoneStarted", false) })
    } finally {
      controller.disconnect()
      controller.setPersona(original.toString())
      await { !controller.state.value.configuring }
    }
  }

  @Test fun externalSpeakerQuestionTravelsThroughPhysicalMicrophone() {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      var before = controller.observedTurns.get()
      SensorServiceController.configureDebugCaptureLimit(45_000)
      SensorServiceController.startLive(context)
      try {
        await { controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.mode == ai.openclaw.clawsense.data.CaptureMode.AUDIO_ONLY }
        controller.text("我们现在做一次麦克风检测。请只回复：准备好了。")
        await { controller.observedTurns.get() > before && controller.state.value.turnCompleted }
        await { !controller.state.value.speaking }
        Thread.sleep(1600)
        before = controller.observedTurns.get()
        controller.resetInputLevel()
        report("acoustic-ready", buildJsonObject { put("ready", true) })
        await(40_000) { controller.observedTurns.get() > before && controller.state.value.turnCompleted }
        val heard = controller.state.value.transcript
        assertTrue("External speech not recognized: $heard", heard.contains("加") && (heard.contains("七") || heard.contains("7")))
        val answer = controller.state.value.answer
        assertTrue("Wrong arithmetic reply: $answer", answer.contains("十二") || answer.contains("12"))
        report("acoustic-input", buildJsonObject { put("transcript", heard); put("answer", answer); put("physicalMicrophoneUsed", true); put("source", "Mac speaker, system synthesized Chinese"); put("humanSpeakerUsed", false) })
      } finally {
        report("acoustic-last-state", buildJsonObject { put("transcript", controller.state.value.transcript); put("answer", controller.state.value.answer); put("frames", controller.inputFrames.get()); put("inputRmsMax", controller.inputRmsMax); put("turns", controller.observedTurns.get()); put("error", controller.state.value.error) })
        SensorServiceController.stop(context); controller.disconnect()
      }
    }
  }

  @Test fun streamingConversationAndInterruptKeepOldAudioStopped() {
    pair()
    prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      controller.connect()
      await { controller.state.value.connected }
      val first = controller.observedTurns.get()
      val timings = mutableListOf<Long>()
      val measurements = mutableListOf<JsonObject>()
      val confirmedBudget = InstrumentationRegistry.getArguments().getString("confirmedBudget", "三万")
      val queries = listOf(
        "这是合成测试。小陈希望周四收到方案，预算三万元。明天下午三点开会。请简短确认。",
        "小陈希望什么时候收到方案？", "预算是多少？", "方案给谁？", "明天会议几点？",
        "请简短复述小陈的约定。", "预算再确认一下。", "接收方叫什么？", "会议的原时间怎么说？", "结束前简短总结。"
      )
      try {
        queries.forEachIndexed { index, query ->
          val count = controller.observedTurns.get()
          val start = SystemClock.elapsedRealtime()
          controller.text(query)
          await { controller.observedTurns.get() > count }
          await { controller.state.value.turnCompleted || controller.state.value.error != null }
          assertNull(controller.state.value.error)
          assertTrue(controller.state.value.answer.isNotBlank())
          val answer = controller.state.value.answer
          when (index) {
            1 -> assertTrue("Wrong deadline: $answer", answer.contains("周四") || answer.contains("星期四"))
            2, 6 -> assertTrue("Wrong budget: $answer", if (confirmedBudget == "四万") answer.contains("四万") || answer.contains("4万") || answer.contains("40,000") || answer.contains("40000") else answer.contains("三万") || answer.contains("3万") || answer.contains("30,000") || answer.contains("30000"))
            3, 7 -> assertTrue("Wrong recipient: $answer", answer.contains("小陈"))
            4, 8 -> assertTrue("Wrong meeting time: $answer", answer.contains("三点") || answer.contains("3点") || answer.contains("15:00"))
          }
          await(3000) { controller.firstAudioElapsedMs >= start }
          await { !controller.state.value.speaking }
          timings.add(controller.firstAudioElapsedMs - start)
          measurements.add(buildJsonObject {
            put("turn", index + 1); put("inputToFirstPacketMs", controller.firstAudioReceivedElapsedMs - start)
            put("firstPacketToAudioTrackMs", controller.firstAudioElapsedMs - controller.firstAudioReceivedElapsedMs)
            if (controller.state.value.hostTimingsJson.isNotBlank()) put("host", Json.parseToJsonElement(controller.state.value.hostTimingsJson))
          })
          report("conversation-progress", buildJsonObject { put("completedTurns", index + 1); put("lastAnswer", controller.state.value.answer) })
        }
        assertEquals(10, controller.observedTurns.get() - first)
        val count = controller.observedTurns.get()
        controller.text("这是停止测试，请连续说十句关于合成测试的解释。")
        await { controller.observedTurns.get() > count && controller.state.value.speaking }
        val stopStart = SystemClock.elapsedRealtime()
        controller.interrupt()
        await(3000) { !controller.state.value.speaking && controller.playbackState() != AudioTrack.PLAYSTATE_PLAYING }
        val stopMs = controller.lastStopElapsedMs - stopStart
        Thread.sleep(300)
        val writes = controller.audioWrites.get()
        Thread.sleep(800)
        assertEquals("Old audio resumed after interrupt", writes, controller.audioWrites.get())
        assertTrue("Answer text must remain", controller.state.value.answer.isNotBlank())
        assertTrue("AudioTrack stop exceeded target", stopMs <= 300)
        report("conversation", buildJsonObject {
          put("turns", 10); put("typedTextToAudioTrackMs", JsonArray(timings.map(::JsonPrimitive)))
          put("measurements", JsonArray(measurements))
          put("expectedConfirmedBudget", confirmedBudget)
          put("buttonToAudioTrackPauseMs", stopMs); put("oldAudioResumed", false)
          put("microphoneUsedForTheseTurns", false); put("humanNaturalnessAccepted", false)
        })
      } finally { controller.disconnect() }
    }
  }

  @Test fun liveOnlyUsesOneMicrophoneAndEndReleasesIt() {
    if (AppGraph.repository(context).session.value == null) pair()
    prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      controller.disconnect()
      val before = controller.inputFrames.get()
      SensorServiceController.configureDebugCaptureLimit(60_000)
      SensorServiceController.startLive(context)
      try {
        await { controller.state.value.connected && controller.inputFrames.get() > before + 8 }
        Thread.sleep(1800) // Let AudioRecord startup and a possible initial partial utterance settle.
        assertFalse("Live-only should not enable restart recording", AppGraph.repository(context).serviceEnabled.value)
        assertEquals("Live-only started a camera", ai.openclaw.clawsense.data.CaptureMode.AUDIO_ONLY, AppGraph.repository(context).runtimeStatus.value.mode)
        val turns = controller.observedTurns.get()
        controller.text("请读这条合成测试消息：小陈周四收到方案，预算三万元。")
        await { controller.observedTurns.get() > turns && controller.state.value.turnCompleted }
        await { !controller.state.value.speaking }
        Thread.sleep(2500)
        assertEquals("Playback echo opened a new turn", turns + 1, controller.observedTurns.get())
        SensorServiceController.stopLive(context)
        await { !controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
        Thread.sleep(300)
        val frames = controller.inputFrames.get(); Thread.sleep(500)
        assertEquals("Microphone still delivering frames after end", frames, controller.inputFrames.get())
        report("microphone", buildJsonObject { put("microphoneFrames", frames - before); put("echoOpenedTurn", false); put("releasedAfterEnd", true); put("humanNaturalnessAccepted", false) })
      } finally {
        report("microphone-last-state", buildJsonObject {
          put("connected", controller.state.value.connected); put("completed", controller.state.value.turnCompleted)
          put("frames", controller.inputFrames.get() - before); put("turns", controller.observedTurns.get())
          put("error", controller.state.value.error); put("phase", AppGraph.repository(context).runtimeStatus.value.phase.name)
        })
        SensorServiceController.stop(context); controller.disconnect()
      }
    }
  }

  @Test fun unavailableHostStartStopsCaptureAndReportsAnError() {
    org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("hostUnavailable") == "true")
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      SensorServiceController.configureDebugCaptureLimit(20_000)
      try {
        SensorServiceController.startLive(context)
        await(15_000) { !controller.state.value.connecting && controller.state.value.error != null && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
        assertFalse(controller.state.value.connected)
        assertTrue(controller.state.value.error!!.contains("无法连接电脑"))
        Thread.sleep(400); val frames = controller.inputFrames.get(); Thread.sleep(500)
        assertEquals("Failed startup kept the microphone running", frames, controller.inputFrames.get())
        report("unavailable-host-start", buildJsonObject { put("error", controller.state.value.error); put("microphoneReleased", true); put("connected", false) })
      } finally { SensorServiceController.stop(context); controller.disconnect() }
    }
  }

  @Test fun activityValidationLimitEndsLiveWithoutHostDisconnection() {
    pair(); prepareLiveOnly()
    val persisted = InstrumentationRegistry.getArguments().getString("persistedValidationLimit") == "true"
    val intent = android.content.Intent(context, MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      .putExtra("validationKeepScreenOn", true)
    if (!persisted) intent.putExtra("validationCaptureLimitMs", 5_000L)
    ActivityScenario.launch<MainActivity>(intent).use {
      try {
        if (persisted) {
          assertEquals("Process restart lost the saved capture limit", 5_000L, SensorServiceController.consumeDebugCaptureLimit(context))
          val beforeWarmup = controller.inputFrames.get()
          controller.connect(); await { controller.state.value.connected }; controller.disconnect()
          assertEquals("Model preparation opened a microphone", beforeWarmup, controller.inputFrames.get())
          Thread.sleep(500)
        }
        repeat(2) {
        val before = controller.inputFrames.get()
        SensorServiceController.startLive(context)
        await(10_000) { controller.state.value.connected && controller.inputFrames.get() > before + 8 }
        await(12_000) { !controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
        Thread.sleep(400); val frames = controller.inputFrames.get(); Thread.sleep(500)
        assertEquals(frames, controller.inputFrames.get())
        }
        report("activity-validation-limit", buildJsonObject { put("limitMs", 5000); put("consecutiveStarts", 2); put("configuredBeforeProcessRestart", persisted); put("connectedBeforeExpiry", true); put("microphoneReleased", true); put("hostShutdownRequired", false) })
      } finally { SensorServiceController.stop(context); controller.disconnect(); SensorServiceController.configureDebugValidationWindow(context, 0L) }
    }
  }

  @Test fun cameraTogglePlaybackCalibration() {
    pair(); prepareLiveOnly()
    val results = mutableListOf<JsonObject>()
    ActivityScenario.launch(MainActivity::class.java).use {
      for (visual in listOf(false, true, true, false)) {
        prepareLiveOnly(); SensorServiceController.configureDebugCaptureLimit(30_000)
        try {
          val inputBefore = controller.inputFrames.get()
          SensorServiceController.startLive(context, visual = visual)
          await { controller.state.value.connected && controller.inputFrames.get() > inputBefore + 8 && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.RUNNING }
          assertEquals(if (visual) ai.openclaw.clawsense.data.CaptureMode.FULL else ai.openclaw.clawsense.data.CaptureMode.AUDIO_ONLY, AppGraph.repository(context).runtimeStatus.value.mode)
          if (visual) {
            val provider = androidx.camera.lifecycle.ProcessCameraProvider.getInstance(context).get()
            val info = androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA.filter(provider.availableCameraInfos).first()
            await { info.cameraState.value?.type == androidx.camera.core.CameraState.Type.OPEN }
          }
          val before = controller.observedTurns.get(); val writes = controller.audioWrites.get(); val submitted = SystemClock.elapsedRealtime()
          controller.text("七加五是多少？")
          await { controller.observedTurns.get() > before && controller.state.value.turnCompleted && controller.audioWrites.get() > writes }
          await { !controller.state.value.speaking }
          assertTrue(controller.state.value.answer.contains("12"))
          // Read our own player's diagnostics; no camera image is requested or saved.
          val field = controller.javaClass.getDeclaredField("track").apply { isAccessible = true }
          val track = field.get(controller) as AudioTrack
          val playedFrames = track.playbackHeadPosition.toLong() and 0xffffffffL
          val duration = playedFrames * 1000.0 / track.sampleRate
          results.add(buildJsonObject {
            put("cameraEnabled", visual); put("sampleRateHz", track.sampleRate); put("playbackRateHz", track.playbackRate)
            put("underruns", track.underrunCount); put("playedFrames", playedFrames); put("playedPcmMs", duration)
            put("inputToFirstAudioMs", controller.firstAudioElapsedMs - submitted)
            put("firstAudioToFinishedMs", SystemClock.elapsedRealtime() - controller.firstAudioElapsedMs)
            put("answer", controller.state.value.answer); put("imagesRequested", false); put("humanVoiceUsed", false)
          })
          report("camera-playback-calibration", buildJsonObject { put("rounds", JsonArray(results)) })
        } finally { SensorServiceController.stop(context); controller.disconnect() }
      }
    }
  }

  @Test fun generalQuestionsProduceAnswersAndPlaybackWithoutMicrophone() {
    pair(); prepareLiveOnly()
    val results = mutableListOf<JsonObject>()
    ActivityScenario.launch(MainActivity::class.java).use {
      val inputBefore = controller.inputFrames.get()
      controller.connect(); await { controller.state.value.connected }
      try {
        for ((kind, query) in listOf(
          "translation" to "把这句话翻译成英语：谢谢你今天的帮助。",
          "explanation" to "为什么天空是蓝色的？请用两句话解释。",
          "advice" to "明天要见客户，我该准备些什么？请用两句话回答。"
        )) {
          val turns = controller.observedTurns.get(); val writes = controller.audioWrites.get()
          controller.text(query)
          await { controller.observedTurns.get() > turns && (controller.state.value.turnCompleted || controller.state.value.error != null) }
          assertNull(controller.state.value.error)
          await(3000) { controller.audioWrites.get() > writes }
          await { !controller.state.value.speaking }
          val answer = controller.state.value.answer
          when (kind) {
            "translation" -> assertTrue("Wrong translation: $answer", answer.contains("thank", true) && answer.contains("help", true))
            "explanation" -> assertTrue("Missing scattering explanation: $answer", answer.contains("散射") && !answer.contains("吸收了红光"))
            "advice" -> assertTrue("No actionable preparation: $answer", Regex("需求|目标|资料|材料|手册|提案|问题|报价").containsMatchIn(answer))
          }
          assertTrue("No audio reached the phone", controller.audioWrites.get() > writes)
          results.add(buildJsonObject { put("kind", kind); put("query", query); put("answer", answer); put("audioPlayed", true) })
          report("general-questions", buildJsonObject { put("rounds", JsonArray(results)); put("microphoneUsed", false); put("humanNaturalnessAccepted", false) })
        }
        assertEquals("Text-only calibration opened the microphone", inputBefore, controller.inputFrames.get())
      } finally { controller.disconnect(); SensorServiceController.stop(context) }
    }
  }

  @Test fun controlledAudioFocusLossStopsLiveWithoutResuming() {
    pair(); prepareLiveOnly()
    val manager = context.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
    val competing = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
      .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).build())
      .setOnAudioFocusChangeListener { }.build()
    ActivityScenario.launch(MainActivity::class.java).use {
      SensorServiceController.configureDebugCaptureLimit(60_000)
      SensorServiceController.startLive(context)
      try {
        await { controller.state.value.connected && controller.inputFrames.get() > 8 }
        assertEquals(android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED, manager.requestAudioFocus(competing))
        await { !controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
        manager.abandonAudioFocusRequest(competing)
        Thread.sleep(500); val frames = controller.inputFrames.get(); Thread.sleep(1200)
        assertEquals("Microphone restarted after focus returned", frames, controller.inputFrames.get())
        assertFalse(controller.state.value.connected)
        report("focus-loss", buildJsonObject { put("controlledFocusLoss", true); put("realTelephoneCall", false); put("microphoneReleased", true); put("automaticallyResumed", false) })
      } finally { manager.abandonAudioFocusRequest(competing); SensorServiceController.stop(context); controller.disconnect() }
    }
  }

  @Test fun backgroundAndEmulatedScreenSleepKeepSingleSessionUntilEnd() {
    org.junit.Assume.assumeTrue("Screen sleep is confined to the disposable emulator", android.os.Build.MODEL.startsWith("sdk_gphone"))
    pair(); prepareLiveOnly()
    fun shell(command: String) { InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { descriptor -> android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() } } }
    ActivityScenario.launch(MainActivity::class.java).use { activity ->
      SensorServiceController.configureDebugCaptureLimit(60_000); SensorServiceController.startLive(context)
      try {
        await { controller.state.value.connected && controller.inputFrames.get() > 8 }
        val before = controller.inputFrames.get()
        activity.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        shell("input keyevent KEYCODE_SLEEP")
        Thread.sleep(1500)
        assertTrue("Foreground microphone did not continue in background", controller.inputFrames.get() > before + 8)
        assertTrue(controller.state.value.connected)
        shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard")
        activity.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        SensorServiceController.stopLive(context)
        await { !controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
        Thread.sleep(400); val frames = controller.inputFrames.get(); Thread.sleep(600)
        assertEquals(frames, controller.inputFrames.get())
        report("background-screen-sleep", buildJsonObject { put("emulatorOnly", true); put("backgroundAndScreenSleep", true); put("releasedAfterEnd", true); put("physicalSecureLockscreenAccepted", false) })
      } finally { shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard"); SensorServiceController.stop(context); controller.disconnect() }
    }
  }

  @Test fun lostHostConnectionStopsLiveOnlyMicrophone() {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      SensorServiceController.configureDebugCaptureLimit(60_000); SensorServiceController.startLive(context)
      try {
        await { controller.state.value.connected && controller.inputFrames.get() > 8 }
        report("network-loss-ready", buildJsonObject { put("ready", true) })
        // The harness stops only its isolated companion after observing this marker.
        await(40_000) { !controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
        Thread.sleep(400); val frames = controller.inputFrames.get(); Thread.sleep(1000)
        assertEquals("Live-only microphone survived a disconnected host", frames, controller.inputFrames.get())
        assertFalse(controller.state.value.connecting)
        report("network-loss", buildJsonObject { put("hostStopped", true); put("microphoneReleased", true); put("automaticallyReconnected", false) })
      } finally { SensorServiceController.stop(context); controller.disconnect() }
    }
  }

  @Test fun synthesizedSpeechUsesPhoneTransportAsrAndSpokenStop() {
    pair()
    prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      controller.connect(); await { controller.state.value.connected }
      fun feed(name: String): Long {
        val pcm = File(directory, "$name.pcm").readBytes()
        var lastVoiced = SystemClock.elapsedRealtime()
        pcm.asList().chunked(640).forEach { data ->
          val frame = data.toByteArray()
          var power = 0.0
          for (i in 0 until frame.size - 1 step 2) { val sample = ((frame[i].toInt() and 255) or (frame[i + 1].toInt() shl 8)).toShort().toDouble() / 32768.0; power += sample * sample }
          if (kotlin.math.sqrt(power / maxOf(1, frame.size / 2)) >= 0.008) lastVoiced = SystemClock.elapsedRealtime()
          controller.feed(frame); Thread.sleep(20)
        }
        repeat(50) { controller.feed(ByteArray(640)); Thread.sleep(20) }
        return lastVoiced
      }
      try {
        var count = controller.observedTurns.get()
        controller.text("这是合成测试。小陈希望周四收到方案，预算三万元。请简短确认。")
        await { controller.observedTurns.get() > count && controller.state.value.turnCompleted }
        await { !controller.state.value.speaking }
        count = controller.observedTurns.get()
        val questionEnd = feed("question")
        await { controller.observedTurns.get() > count && controller.state.value.turnCompleted }
        assertTrue("Speech answer lost context", controller.state.value.answer.contains("周四") || controller.state.value.answer.contains("星期四"))
        val transcript = controller.state.value.transcript
        val responseMs = controller.firstAudioElapsedMs - questionEnd
        await { !controller.state.value.speaking }
        count = controller.observedTurns.get()
        controller.text("请连续说十句关于合成测试的解释。")
        await { controller.observedTurns.get() > count && controller.state.value.speaking }
        val stopStarted = SystemClock.elapsedRealtime(); val stopEnd = feed("stop")
        await { !controller.state.value.speaking && controller.playbackState() != AudioTrack.PLAYSTATE_PLAYING }
        Thread.sleep(300); val writes = controller.audioWrites.get(); Thread.sleep(800)
        assertEquals("Audio resumed after spoken stop", writes, controller.audioWrites.get())
        assertEquals("Stop word generated another answer", count + 1, controller.observedTurns.get())
        assertTrue("ASR did not recognize stop", controller.state.value.transcript.contains("停"))
        report("synthetic-speech", buildJsonObject { put("questionTranscript", transcript); put("deadline", "周四"); put("syntheticLastVoicedFrameToAudioTrackMs", responseMs); put("syntheticStopLastVoicedFrameToAudioTrackPauseMs", controller.lastStopElapsedMs - stopEnd); put("firstPauseFromStopInputStartMs", (controller.firstPauseAfter(stopStarted) ?: 0) - stopStarted); put("firstPauseFromLastVoicedFrameMs", (controller.firstPauseAfter(stopStarted) ?: 0) - stopEnd); put("spokenStopRecognized", true); put("oldAudioResumed", false); put("syntheticPcm", true); put("humanMicrophoneSpeech", false) })
      } finally { controller.disconnect() }
    }
  }

  @Test fun realDshFileReturnsToPhoneAndReconnectDoesNotRepeatRequest() {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      controller.connect(); await { controller.state.value.connected }
      val requestId = java.util.UUID.randomUUID().toString()
      val query = "交给DSH写一个 live-device-quote.md 文件。内容精确为：测试客户小陈周四收到方案，预算四万元。最后回复文件名和结果。"
      try {
        controller.text(query, requestId)
        await(180_000) { controller.state.value.workResults.contains("live-device-quote.md") || controller.state.value.error != null }
        assertNull(controller.state.value.error)
        await { controller.state.value.workResults.contains("live-device-quote.md") && controller.state.value.workResults.contains("四万元") }
        assertTrue("Saving must not imply owner acceptance", controller.state.value.workResults.contains("待本人复核"))
        val result = controller.state.value.workResults
        controller.disconnect(); Thread.sleep(300); controller.connect(); await { controller.state.value.connected }
        val after = controller.observedTurns.get()
        controller.text(query, requestId)
        await { controller.state.value.notice?.contains("不会重复执行") == true }
        Thread.sleep(800); assertEquals("Reconnect repeated a work request", after, controller.observedTurns.get())
        report("dsh-handoff", buildJsonObject { put("actualHost", "DSH"); put("file", "live-device-quote.md"); put("result", result); put("reconnectExecutedAgain", false); put("ownerReview", "pending") })
      } finally { controller.disconnect() }
    }
  }
  @Test fun currentCameraFrameIsRequestedOnceAndEndsWithLive() {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      SensorServiceController.configureDebugCaptureLimit(90_000)
      SensorServiceController.configureDebugImageOnly(true)
      SensorServiceController.startLive(context, visual = true)
      try {
        await { controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.mode == ai.openclaw.clawsense.data.CaptureMode.IMAGE_ONLY }
        val before = controller.observedTurns.get()
        controller.text("我现在在看什么？只说眼前可见的物体。")
        await(90_000) { controller.state.value.error != null || (controller.observedTurns.get() > before && controller.state.value.turnCompleted) }
        val unclear = controller.state.value.diagnosticCode == "current_frame_unreadable"
        if (unclear) {
          assertTrue("Unreliable visual text must not remain visible", controller.state.value.answer.isBlank())
          assertTrue(controller.state.value.visualDescription.isBlank())
        } else {
          assertNull(controller.state.value.error)
          assertTrue("No current frame description", controller.state.value.visualDescription.isNotBlank())
        }
        report("current-camera", buildJsonObject { put("physicalCamera", !android.os.Build.MODEL.startsWith("sdk_gphone")); put("cameraHalUsed", true); put("modelOutcome", if (unclear) "unreadable-explicitly-reported" else "description-returned"); put("description", controller.state.value.visualDescription); put("answer", controller.state.value.answer); put("humanRelevanceAccepted", false) })
      } finally { SensorServiceController.stopLive(context); await { !controller.state.value.connected && AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED } }
    }
  }

  @Test fun stoppingAnIdleServiceCannotDisconnectTheNextLive() {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      val frames = controller.inputFrames.get()
      try {
        repeat(3) {
          SensorServiceController.stop(context)
          await { AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED }
          controller.connect(); await { controller.state.value.connected }
          val before = controller.observedTurns.get(); controller.text("七加五是多少？")
          await { controller.observedTurns.get() > before && controller.state.value.turnCompleted }
          await { !controller.state.value.speaking }; Thread.sleep(700)
          assertTrue("Late service cleanup disconnected the next session", controller.state.value.connected)
          assertTrue(controller.state.value.answer.contains("12"))
        }
        assertEquals("Idle stops started a microphone", frames, controller.inputFrames.get())
        report("idle-stop-handoff", buildJsonObject { put("repeats", 3); put("nextSessionConnected", true); put("microphoneStarted", false) })
      } finally { controller.disconnect(); SensorServiceController.stop(context) }
    }
  }

  @Test fun expiredFrameCannotLeaveThePreviousVisualAnswerOnScreen() {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      val image = File(directory, "mixed-shapes.jpg").readBytes()
      controller.setVisualEnabled(true)
      controller.captureFrame = { ai.openclaw.clawsense.data.CapturedImageFrame(image, capturedAt = System.currentTimeMillis()) }
      try {
        controller.connect(); await { controller.state.value.connected }
        val before = controller.observedTurns.get(); controller.text("我现在在看什么？")
        await { controller.observedTurns.get() > before && controller.state.value.turnCompleted }
        await { !controller.state.value.speaking }
        assertTrue(controller.state.value.visualDescription.isNotBlank())
        val writes = controller.audioWrites.get()
        controller.captureFrame = { ai.openclaw.clawsense.data.CapturedImageFrame(image, capturedAt = System.currentTimeMillis() - 3000) }
        controller.text("我现在在看什么？")
        await { controller.state.value.error != null }
        assertTrue(controller.state.value.error!!.contains("没有取得本次"))
        assertTrue("Old answer looked like a new visual reply", controller.state.value.answer.isBlank())
        assertTrue(controller.state.value.visualDescription.isBlank())
        Thread.sleep(500); assertEquals(writes, controller.audioWrites.get())
        report("expired-frame", buildJsonObject { put("oldAnswerCleared", true); put("oldVisualDescriptionCleared", true); put("oldAudioReplayed", false); put("input", "controlled synthetic JPEG with stale capture time") })
      } finally { controller.captureFrame = null; controller.setVisualEnabled(false); controller.disconnect() }
    }
  }

  @Test fun repeatedSpokenStopsDoNotBackUpTheInputQueue() {
    pair(); prepareLiveOnly()
    val pcm = File(directory, "stop.pcm").readBytes(); val rows = mutableListOf<JsonObject>()
    ActivityScenario.launch(MainActivity::class.java).use {
      controller.connect(); await { controller.state.value.connected }
      try {
        repeat(5) { round ->
          val before = controller.observedTurns.get(); controller.text("请详细说明见客户前的准备事项。")
          await { controller.observedTurns.get() > before && controller.state.value.speaking }
          val start = SystemClock.elapsedRealtime()
          var offset = 0
          while (offset < pcm.size) { controller.feed(pcm.copyOfRange(offset, minOf(offset + 640, pcm.size))); offset += 640; Thread.sleep(20) }
          repeat(60) { controller.feed(ByteArray(640)); Thread.sleep(20) }
          await { controller.state.value.error != null || (!controller.state.value.speaking && controller.state.value.transcript.contains("停")) }
          assertNull(controller.state.value.error); assertTrue(controller.state.value.connected)
          val writes = controller.audioWrites.get(); Thread.sleep(800); assertEquals(writes, controller.audioWrites.get())
          assertEquals(before + 1, controller.observedTurns.get())
          rows.add(buildJsonObject { put("round", round); put("inputStartToFirstPauseMs", (controller.firstPauseAfter(start) ?: 0L) - start); put("oldAudioResumed", false) })
          report("repeated-spoken-stop", buildJsonObject { put("input", "synthetic stop PCM; no microphone"); put("rows", JsonArray(rows)); put("connected", controller.state.value.connected) })
        }
      } finally { controller.disconnect(); SensorServiceController.stop(context) }
    }
  }

  @Test fun cameraVideoAndCancellationPreserveTheCaptureContract() = runBlocking {
    pair(); prepareLiveOnly()
    ActivityScenario.launch(MainActivity::class.java).use {
      val hal = ai.openclaw.clawsense.sensors.CameraXImageSensorHal(context)
      try {
        val priorFiles = context.cacheDir.listFiles()?.map { it.name }?.toSet().orEmpty()
        hal.start(); val clip = hal.recordVideoClip(6_000)
        assertTrue(clip.bytes.size > 1000); assertEquals("video/mp4", clip.mime)
        assertTrue(clip.keyframes.size >= 2)
        val cancelled = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch { hal.recordVideoClip(6_000) }
        kotlinx.coroutines.delay(1000); cancelled.cancel(); cancelled.join()
        val active = hal.javaClass.getDeclaredField("activeRecording").apply { isAccessible = true }
        await(10_000) { runBlocking(kotlinx.coroutines.Dispatchers.Main) { active.get(hal) == null } }
        val leftovers = context.cacheDir.listFiles()?.filter { it.name !in priorFiles && it.extension == "mp4" }.orEmpty()
        assertTrue("Cancelled video left a temporary recording", leftovers.isEmpty())
        report("video-contract", buildJsonObject { put("videoBytes", clip.bytes.size); put("keyframes", clip.keyframes.size); put("cancelledTemporaryFiles", leftovers.size); put("physicalCamera", !android.os.Build.MODEL.startsWith("sdk_gphone")) })
      } finally { hal.stop() }
    }
  }
}
