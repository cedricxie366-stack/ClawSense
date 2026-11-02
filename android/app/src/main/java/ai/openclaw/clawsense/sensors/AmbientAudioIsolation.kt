package ai.openclaw.clawsense.sensors

/** Separate explicit queries from ambient audio, including already buffered frames. */
internal class AmbientAudioIsolation {
  private data class Policy(val suppressed: Boolean, val generation: Long)
  @Volatile private var policy = Policy(false, 0L)
  private var observedGeneration = 0L

  @Synchronized fun setSuppressed(suppressed: Boolean) {
    val current = policy
    if (current.suppressed != suppressed) policy = Policy(suppressed, current.generation + 1L)
  }

  // Called by the single recorder loop. A complete pause/resume between reads
  // must still discard the old pre-roll and partial conversation.
  fun allowFrame(clearBufferedCapture: () -> Unit): Boolean {
    val current = policy
    if (observedGeneration != current.generation) {
      clearBufferedCapture()
      observedGeneration = current.generation
    }
    return !current.suppressed
  }
}
