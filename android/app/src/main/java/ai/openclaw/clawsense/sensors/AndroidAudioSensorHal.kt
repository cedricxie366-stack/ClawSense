package ai.openclaw.clawsense.sensors

import ai.openclaw.clawsense.data.CapturedAudioClip
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.sqrt

class AndroidAudioSensorHal(
  private val context: Context,
  private val config: Config = Config(),
) : AudioSensorHal {
  private val tag = "ClawSenseAudio"
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var record: AudioRecord? = null
  private var loopJob: Job? = null

  override suspend fun start(onClip: suspend (CapturedAudioClip) -> Unit) {
    if (loopJob != null) {
      return
    }
    ensurePermission()
    val minBuffer = AudioRecord.getMinBufferSize(
      config.sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    require(minBuffer > 0) { "无法初始化录音缓冲区" }

    val recorder = AudioRecord(
      MediaRecorder.AudioSource.MIC,
      config.sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minBuffer * 2, config.readFrameSize * 2),
    )
    check(recorder.state == AudioRecord.STATE_INITIALIZED) {
      "AudioRecord 初始化失败"
    }
    recorder.startRecording()
    Log.d(tag, "AudioRecord started. sampleRate=${config.sampleRate} threshold=${config.vadThresholdRms}")
    record = recorder

    loopJob = scope.launch {
      val frame = ShortArray(config.readFrameSize)
      val pcmBuffer = ByteArrayOutputStream()
      var capturing = false
      var clipStartElapsed = 0L
      var lastVoiceElapsed = 0L

      while (isActive) {
        val read = recorder.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING)
        if (read <= 0) {
          continue
        }
        val nowElapsed = android.os.SystemClock.elapsedRealtime()
        val rms = computeRms(frame, read)
        val voiced = rms >= config.vadThresholdRms

        if (voiced) {
          if (!capturing) {
            capturing = true
            clipStartElapsed = nowElapsed
            pcmBuffer.reset()
            Log.d(tag, "VAD triggered. rms=${"%.4f".format(rms)}")
          }
          lastVoiceElapsed = nowElapsed
        }

        if (!capturing) {
          continue
        }

        appendPcm16(frame, read, pcmBuffer)
        val clipDuration = nowElapsed - clipStartElapsed
        val silenceDuration = nowElapsed - lastVoiceElapsed

        val shouldFlush =
          (clipDuration >= config.minClipMs && silenceDuration >= config.silenceTimeoutMs) ||
            clipDuration >= config.maxClipMs

        if (!shouldFlush) {
          continue
        }

        val wav = WavEncoder.wrapPcm16Mono(pcmBuffer.toByteArray(), config.sampleRate)
        capturing = false
        pcmBuffer.reset()
        Log.d(
          tag,
          "Audio clip ready. durationMs=$clipDuration silenceMs=$silenceDuration bytes=${wav.size}",
        )

        onClip(
          CapturedAudioClip(
            bytes = wav,
            fileName = "capture-${System.currentTimeMillis()}.wav",
            capturedAt = System.currentTimeMillis(),
            note = "rms=${"%.3f".format(rms)}",
          ),
        )
      }
    }
  }

  override suspend fun stop() {
    loopJob?.cancelAndJoin()
    loopJob = null
    withContext(Dispatchers.IO) {
      record?.runCatching {
        stop()
        release()
      }
      record = null
    }
  }

  private fun appendPcm16(data: ShortArray, read: Int, out: ByteArrayOutputStream) {
    val bytes = ByteArray(read * 2)
    var byteIndex = 0
    repeat(read) { index ->
      val sample = data[index].toInt()
      bytes[byteIndex++] = (sample and 0xFF).toByte()
      bytes[byteIndex++] = ((sample shr 8) and 0xFF).toByte()
    }
    out.write(bytes)
  }

  private fun computeRms(data: ShortArray, read: Int): Double {
    if (read <= 0) {
      return 0.0
    }
    var sumSquares = 0.0
    repeat(read) { index ->
      val normalized = data[index] / 32768.0
      sumSquares += normalized * normalized
    }
    return sqrt(sumSquares / read)
  }

  private fun ensurePermission() {
    check(
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED,
    ) { "缺少录音权限" }
  }

  data class Config(
    val sampleRate: Int = 16_000,
    val readFrameSize: Int = 2048,
    val vadThresholdRms: Double = 0.012,
    val silenceTimeoutMs: Long = 900,
    val minClipMs: Long = 800,
    val maxClipMs: Long = 15_000,
  )
}
