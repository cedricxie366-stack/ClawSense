package ai.openclaw.clawsense.data

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.DigestInputStream
import java.security.DigestOutputStream
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID

sealed interface PendingUpload {
  val label: String
  data class Audio(val clip: CapturedAudioClip) : PendingUpload { override val label = "音频" }
  data class Image(val image: CapturedImageFrame) : PendingUpload { override val label = "图片" }
  data class Video(val clip: CapturedVideoClip) : PendingUpload { override val label = "视频" }
}

/** Single application-process spool. Repository's upload mutex serializes network use;
 * synchronized methods also protect synchronous clear/session invalidation. A durable
 * record is removed only after an explicit stored acknowledgement. Delivery is at least
 * once: a process can die between the server acknowledgement and local removal. */
class PendingUploadSpool(
  private val directory: File,
  private val maxItems: Int = 6,
  private val maxBytes: Long = 64L * 1024 * 1024,
) {
  data class Entry(val id: String, val upload: PendingUpload, internal val diskBytes: Long)
  data class RestoreResult(val restored: Int, val discarded: Int, val incomplete: Int)
  data class EnqueueResult(val accepted: Boolean, val discarded: Int, val reason: String? = null)
  private val entries = ArrayDeque<Entry>()
  private var binding: String? = null
  private var nextOrder = 0L

  init { require(maxItems > 0 && maxBytes > 0) }

  val size: Int @Synchronized get() = entries.size
  val bytes: Long @Synchronized get() = entries.sumOf { it.diskBytes }

  @Synchronized
  fun restore(session: DeviceSession): RestoreResult {
    val expected = sessionBinding(session)
    if (binding == expected) return RestoreResult(0, 0, 0)
    ensureDirectory()
    entries.clear()
    binding = null
    var discarded = 0
    var incomplete = 0
    val files = directory.listFiles() ?: throw IOException("Cannot list pending-upload storage")
    for (file in files.sortedBy { it.name }) {
      if (file.name.endsWith(".tmp")) {
        deleteFile(file)
        incomplete += 1
      } else if (file.name.endsWith(".upload")) {
        val entry = try {
          if (Files.isSymbolicLink(file.toPath()) || !file.isFile || file.length() > maxBytes) throw IOException("Invalid upload record")
          readRecord(file, expected)
        } catch (_: IOException) {
          deleteFile(file)
          discarded += 1
          null
        } catch (_: IllegalArgumentException) {
          deleteFile(file)
          discarded += 1
          null
        }
        if (entry != null) {
          entries.addLast(entry)
          nextOrder = maxOf(nextOrder, file.name.substringBefore('-').toLongOrNull() ?: 0L)
          while (entries.size > maxItems || bytes > maxBytes) {
            deleteFile(File(directory, entries.first.id))
            entries.removeFirst()
            discarded += 1
          }
        }
      }
    }
    binding = expected
    return RestoreResult(entries.size, discarded, incomplete)
  }

  @Synchronized
  fun enqueue(upload: PendingUpload): EnqueueResult {
    val currentBinding = binding ?: throw IOException("Pending-upload storage has not been restored")
    if (payloadBytes(upload) > maxBytes) return EnqueueResult(false, 0, "single_upload_too_large")
    ensureDirectory()
    nextOrder = maxOf(System.currentTimeMillis(), nextOrder + 1)
    val id = "${nextOrder.toString().padStart(19, '0')}-${UUID.randomUUID()}.upload"
    val destination = File(directory, id)
    val temporary = File(directory, "$id.tmp")
    try {
      writeRecord(temporary, currentBinding, upload)
      val length = temporary.length()
      if (length > maxBytes) return EnqueueResult(false, 0, "single_upload_too_large")
      Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE)
      var discarded = 0
      while (entries.size >= maxItems || bytes + length > maxBytes) {
        deleteFile(File(directory, entries.first.id))
        entries.removeFirst()
        discarded += 1
      }
      entries.addLast(Entry(id, upload, length))
      return EnqueueResult(true, discarded)
    } catch (error: Exception) {
      // A completed rename can be recovered on the next retry after an I/O error.
      binding = null
      entries.clear()
      throw IOException("Cannot persist pending upload", error)
    } finally {
      if (temporary.exists() && !temporary.delete()) throw IOException("Cannot remove incomplete pending upload")
    }
  }

  @Synchronized fun firstOrNull(session: DeviceSession? = null): Entry? {
    if (session != null && binding != sessionBinding(session)) return null
    return entries.peekFirst()
  }

  @Synchronized
  fun acknowledge(id: String, stored: Boolean): Boolean {
    if (!stored) return false
    val entry = entries.firstOrNull { it.id == id } ?: return true
    deleteFile(File(directory, entry.id))
    entries.remove(entry)
    return true
  }

  @Synchronized
  fun clear() {
    entries.clear()
    binding = null
    if (!directory.exists()) return
    val files = directory.listFiles() ?: throw IOException("Cannot list pending-upload storage")
    for (file in files) if (file.name.endsWith(".upload") || file.name.endsWith(".tmp")) deleteFile(file)
  }

  private fun ensureDirectory() {
    if (Files.isSymbolicLink(directory.toPath()) || (!directory.isDirectory && !directory.mkdirs())) throw IOException("Pending-upload directory unavailable")
    Files.setPosixFilePermissions(directory.toPath(), PosixFilePermissions.fromString("rwx------"))
  }

  private fun writeRecord(file: File, scope: String, upload: PendingUpload) {
    Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
    val digest = MessageDigest.getInstance("SHA-256")
    FileOutputStream(file).use { raw ->
      val output = DataOutputStream(DigestOutputStream(BufferedOutputStream(raw), digest))
      output.writeInt(1)
      output.writeUTF(scope)
      when (upload) {
        is PendingUpload.Audio -> { output.writeByte(1); writeMedia(output, upload.clip.bytes, upload.clip.mime, upload.clip.fileName, upload.clip.capturedAt, upload.clip.note); writeDuration(output, upload.clip.durationMs) }
        is PendingUpload.Image -> { output.writeByte(2); writeMedia(output, upload.image.bytes, upload.image.mime, upload.image.fileName, upload.image.capturedAt, upload.image.note) }
        is PendingUpload.Video -> {
          require(upload.clip.keyframes.size <= 6) { "Too many video keyframes" }
          output.writeByte(3)
          writeMedia(output, upload.clip.bytes, upload.clip.mime, upload.clip.fileName, upload.clip.capturedAt, upload.clip.note)
          writeDuration(output, upload.clip.durationMs)
          output.writeInt(upload.clip.keyframes.size)
          for (frame in upload.clip.keyframes) {
            require(frame.videoOffsetMs >= 0)
            output.writeLong(frame.videoOffsetMs)
            writeMedia(output, frame.image.bytes, frame.image.mime, frame.image.fileName, frame.image.capturedAt, frame.image.note)
          }
        }
      }
      output.flush()
      raw.write(digest.digest())
      raw.fd.sync()
    }
  }

  private fun readRecord(file: File, scope: String): Entry {
    val digest = MessageDigest.getInstance("SHA-256")
    val upload = BufferedInputStream(file.inputStream()).use { raw ->
      val input = DataInputStream(DigestInputStream(raw, digest))
      require(input.readInt() == 1) { "Unsupported upload version" }
      require(input.readUTF() == scope) { "Upload belongs to a different pairing" }
      val value = when (input.readUnsignedByte()) {
        1 -> { val media = readMedia(input); PendingUpload.Audio(CapturedAudioClip(media.bytes, media.mime, media.fileName, media.capturedAt, readDuration(input), media.note)) }
        2 -> PendingUpload.Image(readMedia(input))
        3 -> {
          val media = readMedia(input)
          val duration = readDuration(input)
          val count = input.readInt()
          require(count in 0..6)
          val frames = List(count) { val offset = input.readLong(); require(offset >= 0); CapturedVideoKeyframe(readMedia(input), offset) }
          PendingUpload.Video(CapturedVideoClip(media.bytes, media.mime, media.fileName, media.capturedAt, duration, media.note, frames))
        }
        else -> throw IOException("Unknown pending-upload modality")
      }
      val actualDigest = digest.digest()
      val savedDigest = ByteArray(32)
      DataInputStream(raw).readFully(savedDigest)
      require(MessageDigest.isEqual(actualDigest, savedDigest) && raw.read() == -1) { "Damaged pending-upload record" }
      value
    }
    return Entry(file.name, upload, file.length())
  }

  private fun writeMedia(output: DataOutputStream, bytes: ByteArray, mime: String, fileName: String, capturedAt: Long, note: String?) {
    require(bytes.isNotEmpty() && capturedAt >= 0 && fileName.length <= 512 && mime.length <= 200 && (note?.length ?: 0) <= 16_000)
    output.writeUTF(mime)
    output.writeUTF(fileName)
    output.writeLong(capturedAt)
    output.writeBoolean(note != null)
    if (note != null) output.writeUTF(note)
    output.writeInt(bytes.size)
    output.write(bytes)
  }

  private fun readMedia(input: DataInputStream): CapturedImageFrame {
    val mime = input.readUTF()
    val fileName = input.readUTF()
    val capturedAt = input.readLong()
    val note = if (input.readBoolean()) input.readUTF() else null
    val length = input.readInt()
    require(length > 0 && length.toLong() <= maxBytes && length <= input.available() - 32 && capturedAt >= 0)
    require(fileName.length <= 512 && mime.length <= 200 && (note?.length ?: 0) <= 16_000)
    val bytes = ByteArray(length)
    input.readFully(bytes)
    return CapturedImageFrame(bytes, mime, fileName, capturedAt, note)
  }

  private fun writeDuration(output: DataOutputStream, duration: Long?) { require(duration == null || duration >= 0); output.writeBoolean(duration != null); if (duration != null) output.writeLong(duration) }
  private fun readDuration(input: DataInputStream): Long? = if (input.readBoolean()) input.readLong().also { require(it >= 0) } else null
  private fun deleteFile(file: File) { Files.deleteIfExists(file.toPath()) }
  private fun payloadBytes(upload: PendingUpload): Long = when (upload) {
    is PendingUpload.Audio -> upload.clip.bytes.size.toLong()
    is PendingUpload.Image -> upload.image.bytes.size.toLong()
    is PendingUpload.Video -> upload.clip.bytes.size.toLong() + upload.clip.keyframes.sumOf { it.image.bytes.size.toLong() }
  }
  private fun sessionBinding(session: DeviceSession): String = MessageDigest.getInstance("SHA-256")
    .digest(listOf(session.host, session.uploadBaseUrl, session.deviceId, session.deviceSecret).joinToString("\u0000").toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
}
