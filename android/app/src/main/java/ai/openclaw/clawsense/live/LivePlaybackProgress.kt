package ai.openclaw.clawsense.live

/** AudioTrack writes enqueue PCM; its unsigned playback head reports consumption. */
internal class LivePlaybackProgress {
  data class Snapshot(val writtenFrames: Long, val playedFrames: Long) {
    val drained: Boolean get() = playedFrames >= writtenFrames
  }
  private var written = 0L
  private var previousHead = 0L
  private var wraps = 0L
  fun writtenBytes(bytes: Long) { require(bytes >= 0 && bytes % 2 == 0L); written += bytes / 2 }
  fun snapshot(rawHead: Int): Snapshot {
    val head = rawHead.toLong() and 0xffffffffL
    if (head < previousHead) wraps += 1L shl 32
    previousHead = head
    return Snapshot(written, wraps + head)
  }
  fun reset() { written = 0; previousHead = 0; wraps = 0 }
}
