package ai.openclaw.clawsense.live

import java.util.concurrent.atomic.AtomicLong

/** A cancelled player cannot create a track or complete a native write after stop. */
internal class LivePlaybackGate(private val generation: AtomicLong) {
  @Synchronized fun <T> current(epoch: Long, action: () -> T): T? =
    if (epoch == generation.get()) action() else null

  @Synchronized fun cancel(action: () -> Unit) {
    generation.incrementAndGet()
    action()
  }

  @Synchronized fun release(action: () -> Unit) = action()
}
