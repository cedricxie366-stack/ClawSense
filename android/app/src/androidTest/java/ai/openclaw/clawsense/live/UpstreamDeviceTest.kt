package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.service.SensorServiceController
import ai.pipecat.client.PipecatClientOptions
import ai.pipecat.client.PipecatEventCallbacks
import ai.pipecat.client.small_webrtc_transport.*
import ai.pipecat.client.types.*
import ai.pipecat.client.transport.MsgServerToClient
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import android.os.SystemClock

/** Requests suppress output audio. SDK track flags alone do not prevent a
 * native WebRTC device module from accessing the microphone on every vendor. */
class UpstreamDeviceTest {
  @Test fun pairedOfficialClientConnectsAndRepliesWithoutMedia() {
    val instrumentation=InstrumentationRegistry.getInstrumentation()
    val context=instrumentation.targetContext
    assertEquals("This receive-only test requires OS microphone permission denied; track flags are insufficient.",
      android.content.pm.PackageManager.PERMISSION_DENIED,context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO))
    val directory=File(context.filesDir,"live-validation").apply { mkdirs() }
    val setup=File(directory,"setup-code")
    runBlocking {
      if(setup.exists()) { AppGraph.repository(context).pairWithSetupCode(setup.readText().trim(),"OPPO upstream validation","0.3.11");setup.delete() }
    }
    SensorServiceController.stop(context)
    val session=runBlocking { AppGraph.repository(context).requireSession() }
    val ready=CountDownLatch(1);val disconnected=CountDownLatch(1);val completed=CountDownLatch(1)
    val errors=AtomicReference<String?>(null);val answer=StringBuffer();val spoken=AtomicInteger();val tts=AtomicInteger()
    var client:PipecatClientSmallWebRTC?=null
    val start=SystemClock.elapsedRealtime()
    ActivityScenario.launch(UpstreamLiveActivity::class.java).use { scenario ->
      try {
        scenario.onActivity {
          val callbacks=object:PipecatEventCallbacks(){
            override fun onBackendError(message:String){errors.set(message);ready.countDown();completed.countDown()}
            override fun onBotReady(data:BotReadyData){ready.countDown()}
            override fun onDisconnected(){disconnected.countDown()}
            override fun onBotLLMText(data:MsgServerToClient.Data.BotLLMTextData){answer.append(data.text)}
            override fun onBotLLMStopped(){completed.countDown()}
            override fun onBotStartedSpeaking(){spoken.incrementAndGet()}
            override fun onBotTTSStarted(){tts.incrementAndGet()}
          }
          val ice=IceConfig(iceServers=emptyList())
          client=PipecatClientSmallWebRTC(SmallWebRTCTransport(context,iceConfig=ice),PipecatClientOptions(callbacks,enableMic=false,enableCam=false))
          client!!.connect(SmallWebRTCTransportConnectParams(APIRequest(session.uploadBaseUrl.trimEnd('/')+"/live-upstream/offer",Value.Object("vision" to Value.Bool(false)),mapOf("Authorization" to "Bearer ${session.deviceSecret}")),ice)).withCallback { r ->
            if(r.errorOrNull!=null){errors.set("connection_failed: ${r.errorOrNull}");ready.countDown()}
          }
        }
        assertTrue("Official client not ready: ${errors.get()}",ready.await(90,TimeUnit.SECONDS))
        assertNull(errors.get(),errors.get());val readyMs=SystemClock.elapsedRealtime()-start
        scenario.onActivity {
          assertNull(client!!.tracks.local.audio);assertNull(client!!.tracks.local.video)
          client!!.sendText("七加五是多少？",SendTextOptions(runImmediately=true,audioResponse=false))
        }
        assertTrue("No text response: ${errors.get()}",completed.await(40,TimeUnit.SECONDS))
        assertNull(errors.get(),errors.get());assertTrue(answer.toString(),answer.contains("12")||answer.contains("十二"))
        Thread.sleep(1500)
        assertEquals(0,spoken.get());assertEquals(0,tts.get())
        scenario.onActivity {assertNull(client!!.tracks.local.audio);assertNull(client!!.tracks.local.video)}
        File(directory,"upstream-no-media.json").writeText(buildJsonObject {
          put("readyMs",readyMs);put("answer",answer.toString());put("localAudioTrack",false);put("localVideoTrack",false);put("botSpeechEvents",spoken.get());put("botTtsEvents",tts.get());put("officialAndroidSdk",true)
        }.toString())
      } finally {
        scenario.onActivity { client?.disconnect()?.withCallback { client?.release();disconnected.countDown() } }
        assertTrue("SDK release timed out",disconnected.await(10,TimeUnit.SECONDS))
      }
    }
  }
  @Test fun prepareModelsWithoutCreatingRtcOrSensorConnection() {
    val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
    val live=AppGraph.live(context);val before=live.inputFrames.get()
    live.prepare()
    val deadline=SystemClock.elapsedRealtime()+90000
    while((live.lastPreparationMs==0L || live.state.value.backgroundPreparing) && SystemClock.elapsedRealtime()<deadline) Thread.sleep(50)
    assertTrue(live.state.value.error,live.lastPreparationMs>0L)
    assertFalse(live.state.value.connected);assertFalse(live.state.value.connecting)
    assertEquals(before,live.inputFrames.get())
    val directory=File(context.filesDir,"live-validation").apply{mkdirs()}
    File(directory,"upstream-model-preparation.json").writeText(buildJsonObject {
      put("preparationMs",live.lastPreparationMs);put("rtcCreated",false);put("legacyConnected",false);put("inputFrames",live.inputFrames.get()-before)
    }.toString())
  }
}
