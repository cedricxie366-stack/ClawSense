package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.AppGraph
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioTrack
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LivePlaybackDeviceTest {
  @Test fun threeVoiceSamplesUseTheLivePlayerWithoutMicrophone() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val controller = AppGraph.live(context)
    val beforeInput = controller.inputFrames.get()
    val rows = mutableListOf<JsonObject>()
    fun await(condition: () -> Boolean) {
      val until = SystemClock.elapsedRealtime() + 60_000
      while (!condition() && SystemClock.elapsedRealtime() < until) {
        check(controller.state.value.error == null) { controller.state.value.error.orEmpty() }
        check(controller.state.value.notice?.contains("音频占用") != true) { controller.state.value.notice.orEmpty() }
        Thread.sleep(25)
      }
      assertTrue("Voice sample failed: ${controller.state.value.error}", condition())
    }
    try {
      context.startActivity(android.content.Intent(context, ai.openclaw.clawsense.MainActivity::class.java)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        .putExtra("validationKeepScreenOn", true))
      Thread.sleep(500)
      controller.connect(); await { controller.state.value.connected }
      for (phrase in listOf("会议安排在明天下午四点。", "预算五万元，方案周六交付。", "好的，我会先听你说完，再回答当前的问题。")) {
        val count = controller.observedTurns.get()
        controller.text("请只朗读下面的文字，不添加内容：$phrase")
        await { controller.observedTurns.get() > count && controller.state.value.turnCompleted }
        await { !controller.state.value.speaking }
        rows.add(buildJsonObject { put("requested", phrase); put("actual", controller.state.value.answer); put("hostTimingsJson", controller.state.value.hostTimingsJson) })
        File(context.filesDir, "live-validation").apply { mkdirs() }.resolve("voice-audition-progress.json").writeText(JsonArray(rows).toString())
        Thread.sleep(2000)
      }
      assertEquals("Voice audition opened the microphone", beforeInput, controller.inputFrames.get())
    } finally {
      File(context.filesDir, "live-validation").apply { mkdirs() }.resolve("voice-audition.json").writeText(buildJsonObject {
        put("source", "typed requests through actual host TTS and phone Live player")
        put("microphoneFrames", controller.inputFrames.get() - beforeInput)
        put("samples", JsonArray(rows)); put("humanVoiceIdentityAccepted", false)
        put("connected", controller.state.value.connected); put("speaking", controller.state.value.speaking)
        put("turnCompleted", controller.state.value.turnCompleted); put("error", controller.state.value.error)
        put("notice", controller.state.value.notice); put("hostTimingsJson", controller.state.value.hostTimingsJson)
      }.toString())
      controller.disconnect()
    }
  }

  @Test fun rapidTurnChangesReleaseOldPlayersAndCannotResumeStoppedAudio() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val controller = AppGraph.live(context)
    val inputBefore = controller.inputFrames.get()
    val field = LiveController::class.java.getDeclaredField("track").apply { isAccessible = true }
    val rows = mutableListOf<JsonObject>()
    fun await(condition: () -> Boolean) {
      val until = SystemClock.elapsedRealtime() + 60_000
      while (!condition() && SystemClock.elapsedRealtime() < until) Thread.sleep(15)
      assertTrue("Player replacement failed: ${controller.state.value.error}", condition())
    }
    try {
      controller.connect(); await { controller.state.value.connected }
      repeat(2) { round ->
        val before = controller.audioWrites.get()
        controller.text("请连续说明见客户前的准备事项。这是合成播放检查。")
        await { controller.audioWrites.get() > before && controller.state.value.speaking }
        val old = field.get(controller) as AudioTrack
        val turns = controller.observedTurns.get()
        controller.text("请只说：本轮切换完成。")
        await { controller.observedTurns.get() > turns && field.get(controller) != null && field.get(controller) !== old && controller.state.value.speaking }
        assertEquals("Old native player was left alive", AudioTrack.STATE_UNINITIALIZED, old.state)
        val at = SystemClock.elapsedRealtime(); controller.interrupt()
        val pauseMs = controller.lastStopElapsedMs - at
        val writes = controller.audioWrites.get(); Thread.sleep(800)
        assertEquals("Cancelled packets resumed writing", writes, controller.audioWrites.get())
        assertTrue("Stop waited behind a blocked native write", pauseMs <= 300)
        assertEquals(AudioTrack.PLAYSTATE_PAUSED, controller.playbackState())
        assertTrue(controller.state.value.answer.isNotBlank())
        rows.add(buildJsonObject { put("round", round + 1); put("oldNativePlayerReleased", true); put("oldAudioResumed", false); put("buttonToPauseMs", pauseMs) })
      }
      assertEquals(inputBefore, controller.inputFrames.get())
      File(context.filesDir, "live-validation").apply { mkdirs() }.resolve("player-replacement.json").writeText(buildJsonObject {
        put("source", "typed requests; actual phone AudioTrack; no microphone")
        put("rounds", JsonArray(rows)); put("humanOverlapAccepted", false)
      }.toString())
    } finally { controller.disconnect() }
  }

  @Test fun assistantPlaybackFollowsMediaRouteWithoutChangingVolume() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val controller = AppGraph.live(context)
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    check(AppGraph.repository(context).session.value != null) { "Pair this controlled device first" }
    check(AppGraph.repository(context).runtimeStatus.value.phase == ai.openclaw.clawsense.data.ServicePhase.STOPPED)
    val mediaBefore = manager.getStreamVolume(AudioManager.STREAM_MUSIC)
    val callBefore = manager.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
    val inputBefore = controller.inputFrames.get()
    fun await(condition: () -> Boolean) {
      val until = SystemClock.elapsedRealtime() + 60_000
      while (!condition() && SystemClock.elapsedRealtime() < until) Thread.sleep(30)
      assertTrue("Playback check failed: ${controller.state.value.error}", condition())
    }
    try {
        controller.connect(); await { controller.state.value.connected }
        val writes = controller.audioWrites.get()
        controller.text("这是合成播放校准，请只说：声音检查，正在使用手机播放。")
        await { controller.audioWrites.get() > writes }
        // Inspect the actual Live player, rather than creating a second test player.
        val field = LiveController::class.java.getDeclaredField("track").apply { isAccessible = true }
        val track = field.get(controller) as AudioTrack
        await { track.routedDevice != null }
        val route = track.routedDevice!!.type
        val report = buildJsonObject {
          put("usage", track.audioAttributes.usage)
          put("allowedCapturePolicy", track.audioAttributes.allowedCapturePolicy)
          put("volumeControlStream", track.audioAttributes.volumeControlStream)
          put("routedDeviceType", route)
          put("mediaVolumeBefore", mediaBefore); put("mediaVolumeAfter", manager.getStreamVolume(AudioManager.STREAM_MUSIC))
          put("callVolumeBefore", callBefore); put("callVolumeAfter", manager.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
          put("microphoneFrames", controller.inputFrames.get() - inputBefore)
          put("humanLoudnessAccepted", false)
        }
        File(context.filesDir, "live-validation").apply { mkdirs() }.resolve("playback-route.json").writeText(report.toString())
        assertEquals("Live playback uses the call-volume stream", AudioManager.STREAM_MUSIC, track.audioAttributes.volumeControlStream)
        assertEquals("Private speech became available to playback capture", AudioAttributes.ALLOW_CAPTURE_BY_NONE, track.audioAttributes.allowedCapturePolicy)
        assertNotEquals("Assistant playback was routed to the phone earpiece", AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, route)
        assertEquals(mediaBefore, manager.getStreamVolume(AudioManager.STREAM_MUSIC))
        assertEquals(callBefore, manager.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
        assertEquals("Playback-only check opened a microphone", inputBefore, controller.inputFrames.get())
    } finally { controller.disconnect() }
  }
}
