package ai.openclaw.clawsense.live

import org.junit.Assert.*
import org.junit.Test

class LivePlaybackProgressTest {
  @Test fun queuedAudioIsNotCompletedUntilTheHardwareConsumesItsTail() {
    val p = LivePlaybackProgress()
    p.writtenBytes(48000)
    assertFalse(p.snapshot(22000).drained)
    assertFalse(p.snapshot(23999).drained)
    assertTrue(p.snapshot(24000).drained)
    p.writtenBytes(4800)
    assertFalse(p.snapshot(24000).drained)
    assertTrue(p.snapshot(26400).drained)
  }
  @Test fun stopResetsTheOldTrackAndUnsignedCounterWrapDoesNotFinishEarly() {
    val p = LivePlaybackProgress()
    p.writtenBytes(((1L shl 32) + 10) * 2)
    assertFalse(p.snapshot(-2).drained)
    assertFalse(p.snapshot(5).drained)
    assertTrue(p.snapshot(10).drained)
    p.reset(); p.writtenBytes(200)
    assertFalse(p.snapshot(0).drained)
    assertTrue(p.snapshot(100).drained)
  }
}
