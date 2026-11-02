package ai.openclaw.clawsense.live

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.*
import org.junit.Test

class LivePlaybackGateTest {
  @Test fun stopFlushesAfterTheLastOldWriteAndRejectsLateOldTrackCreation() {
    val epoch = AtomicLong(0); val gate = LivePlaybackGate(epoch)
    val entered = CountDownLatch(1); val release = CountDownLatch(1)
    val pool = Executors.newFixedThreadPool(2)
    val events = java.util.Collections.synchronizedList(mutableListOf<String>())
    try {
      val writer = pool.submit { gate.current(0) { entered.countDown(); check(release.await(2, TimeUnit.SECONDS)); events.add("old-write") } }
      assertTrue(entered.await(1, TimeUnit.SECONDS))
      val stop = pool.submit { gate.cancel { events.add("flush") } }
      release.countDown(); writer.get(2, TimeUnit.SECONDS); stop.get(2, TimeUnit.SECONDS)
      assertNull(gate.current(0) { events.add("late-old-track") })
      gate.current(epoch.get()) { events.add("new-write") }
      assertEquals(listOf("old-write", "flush", "new-write"), events)
    } finally { release.countDown(); pool.shutdownNow() }
  }

  @Test fun oldFinishCallbackCannotChangeTheNewPlaybackState() {
    val epoch = AtomicLong(3); val gate = LivePlaybackGate(epoch)
    var speaking = true
    gate.cancel { speaking = false }
    gate.current(4) { speaking = true }
    assertNull(gate.current(3) { speaking = false })
    assertTrue(speaking)
  }
}
