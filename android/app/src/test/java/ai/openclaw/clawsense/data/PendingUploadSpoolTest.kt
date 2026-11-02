package ai.openclaw.clawsense.data

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class PendingUploadSpoolTest {
  private lateinit var root: File
  private val session = DeviceSession("http://host:18789", "device-1", "secret-test-only", "http://host:18789/api/clawsense", 60, "clawsense", 1L)
  private fun spool(maxItems: Int = 6, maxBytes: Long = 64L * 1024 * 1024) = PendingUploadSpool(File(root, "spool"), maxItems, maxBytes)
  private fun audio(value: Int, size: Int = 12) = PendingUpload.Audio(CapturedAudioClip(ByteArray(size) { value.toByte() }, capturedAt = value.toLong(), durationMs = 1_200L, note = "session=test segment=$value"))

  @Before fun setUp() { root = Files.createTempDirectory("clawsense-spool-test-").toFile() }
  @After fun tearDown() { root.deleteRecursively() }

  @Test fun restoresAllModalitiesAndVideoKeyframesAfterRestart() {
    val first = spool()
    first.restore(session)
    first.enqueue(audio(1))
    first.enqueue(PendingUpload.Image(CapturedImageFrame(byteArrayOf(2, 3), capturedAt = 2L, note = "图片注释")))
    val video = CapturedVideoClip(byteArrayOf(4, 5, 6), capturedAt = 3L, durationMs = 6_000L, note = "videoRequestId=test", keyframes = listOf(CapturedVideoKeyframe(CapturedImageFrame(byteArrayOf(7, 8), capturedAt = 4L, note = "keyframe=1"), 150L)))
    first.enqueue(PendingUpload.Video(video))
    val restarted = spool()
    val restored = restarted.restore(session)
    assertEquals(3, restored.restored)
    assertEquals(0, restored.discarded)
    val one = restarted.firstOrNull()!!
    val audioClip = (one.upload as PendingUpload.Audio).clip
    assertArrayEquals(ByteArray(12) { 1 }, audioClip.bytes)
    assertEquals("session=test segment=1", audioClip.note)
    assertEquals(1_200L, audioClip.durationMs)
    restarted.acknowledge(one.id, true)
    val two = restarted.firstOrNull()!!
    val image = (two.upload as PendingUpload.Image).image
    assertEquals("图片注释", image.note)
    assertArrayEquals(byteArrayOf(2, 3), image.bytes)
    restarted.acknowledge(two.id, true)
    val three = (restarted.firstOrNull()!!.upload as PendingUpload.Video).clip
    assertArrayEquals(video.bytes, three.bytes)
    assertEquals(6_000L, three.durationMs)
    assertEquals("videoRequestId=test", three.note)
    assertEquals(150L, three.keyframes.single().videoOffsetMs)
    assertArrayEquals(byteArrayOf(7, 8), three.keyframes.single().image.bytes)
    assertEquals("keyframe=1", three.keyframes.single().image.note)
  }

  @Test fun keepsUnacknowledgedRecordsAcrossRestartsAndDeletesOnlyAcknowledgedEntry() {
    val first = spool()
    first.restore(session)
    first.enqueue(audio(1))
    first.enqueue(audio(2))
    val second = spool()
    second.restore(session)
    val acknowledged = second.firstOrNull()!!
    assertFalse(second.acknowledge(acknowledged.id, false))
    assertEquals(2, spool().restore(session).restored)
    assertTrue(second.acknowledge(acknowledged.id, true))
    val third = spool()
    assertEquals(1, third.restore(session).restored)
    assertEquals(2L, (third.firstOrNull()!!.upload as PendingUpload.Audio).clip.capturedAt)
  }

  @Test fun retainsSixNewestItemsAndReportsExactlyWhatWasDropped() {
    val queue = spool()
    queue.restore(session)
    for (value in 1..6) assertEquals(0, queue.enqueue(audio(value)).discarded)
    val result = queue.enqueue(audio(7))
    assertTrue(result.accepted)
    assertEquals(1, result.discarded)
    assertEquals(6, queue.size)
    val restarted = spool()
    assertEquals(6, restarted.restore(session).restored)
    assertEquals(2L, (restarted.firstOrNull()!!.upload as PendingUpload.Audio).clip.capturedAt)
  }

  @Test fun reappliesBoundsWhenRestoringAnInterruptedOverflowCleanup() {
    val old = spool(maxItems = 8)
    old.restore(session)
    for (value in 1..8) old.enqueue(audio(value))
    val restarted = spool()
    val result = restarted.restore(session)
    assertEquals(6, result.restored)
    assertEquals(2, result.discarded)
    assertEquals(6, File(root, "spool").listFiles()!!.size)
    assertEquals(3L, (restarted.firstOrNull()!!.upload as PendingUpload.Audio).clip.capturedAt)
  }

  @Test fun limitsActualDiskBytesAndRejectsOversizeItemsWithoutEvictingExistingData() {
    val queue = spool(maxBytes = 2_000L)
    queue.restore(session)
    queue.enqueue(audio(1, 800))
    queue.enqueue(audio(2, 800))
    val limited = queue.enqueue(audio(3, 800))
    assertTrue(limited.discarded > 0)
    assertTrue(queue.bytes <= 2_000L)
    val count = queue.size
    val rejected = queue.enqueue(audio(4, 2_001))
    assertFalse(rejected.accepted)
    assertEquals("single_upload_too_large", rejected.reason)
    assertEquals(count, queue.size)
    assertTrue(File(root, "spool").listFiles()!!.sumOf { it.length() } <= 2_000L)
  }

  @Test fun discardsOnlyBrokenOrIncompleteRecordsDuringRecovery() {
    val first = spool()
    first.restore(session)
    first.enqueue(audio(1))
    first.enqueue(audio(2))
    first.enqueue(audio(3))
    val files = File(root, "spool").listFiles()!!.sortedBy { it.name }
    val damaged = files[1].readBytes()
    damaged[damaged.lastIndex] = (damaged.last() + 1).toByte()
    files[1].writeBytes(damaged)
    File(root, "spool/interrupted.upload.tmp").writeText("partial media")
    val restarted = spool()
    val result = restarted.restore(session)
    assertEquals(2, result.restored)
    assertEquals(1, result.discarded)
    assertEquals(1, result.incomplete)
    assertEquals(1L, (restarted.firstOrNull()!!.upload as PendingUpload.Audio).clip.capturedAt)
    restarted.acknowledge(restarted.firstOrNull()!!.id, true)
    assertEquals(3L, (restarted.firstOrNull()!!.upload as PendingUpload.Audio).clip.capturedAt)
  }

  @Test fun cannotReplayOldPrivateMediaUnderAnotherPairing() {
    val first = spool()
    first.restore(session)
    first.enqueue(audio(1))
    val fresh = spool()
    val result = fresh.restore(session.copy(deviceSecret = "new-secret"))
    assertEquals(1, result.discarded)
    assertEquals(0, fresh.size)
    assertEquals(0, File(root, "spool").listFiles()!!.size)
    fresh.enqueue(audio(2))
    assertEquals(1, fresh.restore(session.copy(host = "http://different-host")).discarded)
    assertEquals(0, fresh.size)
  }

  @Test fun keepsFilesPrivateWithoutPersistingCredentials() {
    val queue = spool()
    queue.restore(session)
    queue.enqueue(audio(1))
    val directory = File(root, "spool")
    val file = directory.listFiles()!!.single()
    assertEquals(PosixFilePermissions.fromString("rwx------"), Files.getPosixFilePermissions(directory.toPath()))
    assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(file.toPath()))
    assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains(session.deviceSecret))
    queue.clear()
    assertEquals(0, directory.listFiles()!!.size)
  }

  @Test fun storageFailuresAreReportedWithoutPretendingTheUploadWasQueued() {
    File(root, "spool").writeText("blocks the directory")
    val queue = spool()
    try { queue.restore(session); fail("Expected storage failure") } catch (_: IOException) { }
    assertEquals(0, queue.size)
    assertEquals("blocks the directory", File(root, "spool").readText())
  }
}
