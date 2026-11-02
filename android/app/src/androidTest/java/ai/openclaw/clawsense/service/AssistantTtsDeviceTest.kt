package ai.openclaw.clawsense.service

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AssistantTtsDeviceTest {
  @Test fun longSpeechRemainsActiveUntilStoppedAndCanSpeakAgain() = runBlocking {
    val controller = AssistantTtsController(InstrumentationRegistry.getInstrumentation().targetContext)
    // Synthetic output only. This test does not start a camera or microphone.
    val text = "这是长文本朗读校准，请确认停止操作。".repeat(350) + "校准结束。"
    val playback = async { controller.speak(text) }
    try {
      withTimeout(15000) {
        while (!controller.isSpeaking() && !playback.isCompleted) delay(50)
      }
      assertFalse("Long speech must not finish or fail at the engine input limit", playback.isCompleted)
      assertTrue(controller.isSpeaking())
      delay(1000)
      controller.stopSpeaking()
      assertTrue(withTimeout(2000) { playback.await() }.isSuccess)
      withTimeout(2000) { while (controller.isSpeaking()) delay(50) }
      val next = withTimeout(15000) { controller.speak("校准结束。") }
      assertTrue("A stopped queue must allow the next utterance", next.isSuccess)
    } finally {
      playback.cancelAndJoin()
      controller.shutdown()
    }
  }

  @Test fun stoppingAnAcceptedRequestDoesNotStartSpeakingLater() = runBlocking {
    val controller = AssistantTtsController(InstrumentationRegistry.getInstrumentation().targetContext)
    val playback = async { controller.speak("这是初始化停止校准。".repeat(100)) }
    try {
      withTimeout(2000) { while (!controller.isBusy()) delay(10) }
      controller.stopSpeaking()
      assertTrue(withTimeout(2000) { playback.await() }.isSuccess)
      delay(1500)
      assertFalse("Stopped initialization must not begin playback later", controller.isSpeaking())
      assertTrue(withTimeout(15000) { controller.speak("校准结束。") }.isSuccess)
    } finally {
      playback.cancelAndJoin()
      controller.shutdown()
    }
  }
}
