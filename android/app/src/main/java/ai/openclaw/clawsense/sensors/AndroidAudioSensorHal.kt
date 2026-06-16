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
import java.util.ArrayDeque
import java.util.Locale
import kotlinx.coroutines.CancellationException
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
  @Volatile private var activeAudioSource: Int = config.audioSource
  @Volatile private var pendingQueryCapture: AssistantQueryCapture? = null
  @Volatile private var activeQueryCapture: AssistantQueryCapture? = null

  /**
   * Starts a dedicated push-to-record capture for an explicit assistant query.
   * Recording begins on the next audio frame and ends after a short trailing
   * silence (once any speech was heard) or at the hard duration cap, so it
   * never depends on the ambient VAD flushing a clip. Returns false when a
   * query capture is already in flight. The callback receives null when the
   * window contained no usable speech.
   */
  fun beginAssistantQueryCapture(onResult: suspend (CapturedAudioClip?) -> Unit): Boolean {
    if (pendingQueryCapture != null || activeQueryCapture != null) {
      return false
    }
    pendingQueryCapture = AssistantQueryCapture(onResult)
    return true
  }

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

    val recorder = createRecorder(minBuffer)
    check(recorder.state == AudioRecord.STATE_INITIALIZED) {
      "AudioRecord 初始化失败"
    }
    recorder.startRecording()
    Log.d(
      tag,
      "AudioRecord started. sampleRate=${config.sampleRate} source=${audioSourceName(activeAudioSource)} threshold=${config.vadThresholdRms} minVoicedMs=${config.minVoicedMs}",
    )
    record = recorder

    loopJob = scope.launch {
      val frame = ShortArray(config.readFrameSize)
      val pcmBuffer = ByteArrayOutputStream()
      val preRollFrames = ArrayDeque<BufferedFrame>()
      var capturing = false
      var clipStartElapsed = 0L
      var lastVoiceElapsed = 0L
      var clipVoicedMs = 0L
      var voicedFrameStreak = 0
      var nextCaptureAllowedAt = 0L
      var peakRms = 0.0
      var conversationWindowCounter = 0
      var currentConversationWindowId: String? = null
      var currentConversationWindowStartedAtMs = 0L
      var conversationSegmentIndex = 0
      var lastConversationClipEndedAtElapsed = Long.MIN_VALUE
      var clipStartedAtElapsed = 0L
      var clipStartedAtWallClockMs = 0L

      while (isActive) {
        val read = recorder.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING)
        if (read <= 0) {
          continue
        }
        val nowElapsed = android.os.SystemClock.elapsedRealtime()
        val frameDurationMs = ((read * 1000L) / config.sampleRate).coerceAtLeast(1L)
        val frameBytes = toPcm16Bytes(frame, read)
        val rms = computeRms(frame, read)

        pendingQueryCapture?.let { requested ->
          pendingQueryCapture = null
          capturing = false
          pcmBuffer.reset()
          voicedFrameStreak = 0
          peakRms = 0.0
          clipStartedAtElapsed = 0L
          clipStartedAtWallClockMs = 0L
          clipVoicedMs = 0L
          currentConversationWindowId = null
          currentConversationWindowStartedAtMs = 0L
          conversationSegmentIndex = 0
          lastConversationClipEndedAtElapsed = Long.MIN_VALUE
          requested.begin(
            nowElapsed = nowElapsed,
            preRoll = preRollFrames,
          )
          preRollFrames.clear()
          activeQueryCapture = requested
          Log.d(
            tag,
            "Assistant query capture started maxMs=${config.queryMaxDurationMs} silenceMs=${config.querySilenceTimeoutMs} threshold=${config.queryVadThresholdRms}",
          )
        }

        val query = activeQueryCapture
        if (query != null) {
          val finished = query.acceptFrame(
            frameBytes = frameBytes,
            frameDurationMs = frameDurationMs,
            rms = rms,
            nowElapsed = nowElapsed,
            config = config,
          )
          if (finished) {
            activeQueryCapture = null
            nextCaptureAllowedAt = nowElapsed + config.uploadCooldownMs
            val clip = query.buildClip(config.sampleRate)
            Log.d(
              tag,
              "Assistant query capture finished durationMs=${query.elapsedMs(nowElapsed)} voicedMs=${query.voicedMs} peakRms=${"%.4f".format(query.peakRms)} delivered=${clip != null}",
            )
            try {
              query.onResult(clip)
            } catch (error: Throwable) {
              if (error is CancellationException) {
                throw error
              }
              Log.e(tag, "Assistant query callback failed", error)
            }
          }
          // Query frames never feed the ambient pipeline.
          continue
        }

        val voiced = rms >= config.vadThresholdRms
        if (voiced) {
          voicedFrameStreak += 1
        } else {
          voicedFrameStreak = 0
        }

        if (!capturing) {
          bufferFrame(
            frames = preRollFrames,
            frame = BufferedFrame(
              bytes = frameBytes,
              durationMs = frameDurationMs,
              voiced = voiced,
              rms = rms,
            ),
          )
          if (nowElapsed < nextCaptureAllowedAt || voicedFrameStreak < config.voiceActivationFrames) {
            continue
          }
          val preRollDurationMs = totalDurationMs(preRollFrames)
          capturing = true
          clipStartElapsed = nowElapsed - preRollDurationMs
          clipStartedAtElapsed = clipStartElapsed
          clipStartedAtWallClockMs = System.currentTimeMillis() - preRollDurationMs
          lastVoiceElapsed = nowElapsed
          clipVoicedMs = 0L
          peakRms = 0.0
          pcmBuffer.reset()
          preRollFrames.forEach { buffered ->
            pcmBuffer.write(buffered.bytes)
            if (buffered.voiced) {
              clipVoicedMs += buffered.durationMs
            }
            peakRms = maxOf(peakRms, buffered.rms)
          }
          preRollFrames.clear()
          Log.d(
            tag,
            "VAD triggered. rms=${"%.4f".format(rms)} voicedMs=$clipVoicedMs streak=$voicedFrameStreak",
          )
        } else {
          pcmBuffer.write(frameBytes)
          if (voiced) {
            lastVoiceElapsed = nowElapsed
            clipVoicedMs += frameDurationMs
          }
          peakRms = maxOf(peakRms, rms)
        }

        if (!capturing) {
          continue
        }

        val clipDuration = nowElapsed - clipStartElapsed
        val silenceDuration = nowElapsed - lastVoiceElapsed
        val hitMaxDuration = clipDuration >= config.maxClipMs

        val shouldFlush =
          (clipDuration >= config.minClipMs && silenceDuration >= config.silenceTimeoutMs) ||
            hitMaxDuration

        if (!shouldFlush) {
          continue
        }

        capturing = false
        voicedFrameStreak = 0
        val voicedEnough = clipVoicedMs >= config.minVoicedMs
        if (!voicedEnough) {
          Log.d(
            tag,
            "Discarding fragmented clip. durationMs=$clipDuration voicedMs=$clipVoicedMs peakRms=${"%.4f".format(peakRms)}",
          )
          pcmBuffer.reset()
          preRollFrames.clear()
          nextCaptureAllowedAt = nowElapsed + config.discardCooldownMs
          continue
        }

        val conversationGapMs = if (lastConversationClipEndedAtElapsed == Long.MIN_VALUE) {
          Long.MAX_VALUE
        } else {
          clipStartedAtElapsed - lastConversationClipEndedAtElapsed
        }
        val continuesConversation =
          currentConversationWindowId != null && conversationGapMs <= config.conversationContinuationGapMs
        if (!continuesConversation) {
          conversationWindowCounter += 1
          currentConversationWindowStartedAtMs = clipStartedAtWallClockMs
          currentConversationWindowId = "conv-${currentConversationWindowStartedAtMs}-$conversationWindowCounter"
          conversationSegmentIndex = 0
        }
        conversationSegmentIndex += 1
        val boundaryReason = if (hitMaxDuration) "max-duration" else "silence"
        val note = buildConversationNote(
          sessionId = checkNotNull(currentConversationWindowId),
          segmentIndex = conversationSegmentIndex,
          sessionStartedAtMs = currentConversationWindowStartedAtMs,
          clipDurationMs = clipDuration,
          voicedDurationMs = clipVoicedMs,
          peakRms = peakRms,
          boundaryReason = boundaryReason,
          continued = conversationSegmentIndex > 1 || hitMaxDuration,
        )

        val wav = WavEncoder.wrapPcm16Mono(pcmBuffer.toByteArray(), config.sampleRate)
        pcmBuffer.reset()
        if (!hitMaxDuration) {
          nextCaptureAllowedAt = nowElapsed + config.uploadCooldownMs
        }
        Log.d(
          tag,
          "Audio clip ready. session=$currentConversationWindowId segment=$conversationSegmentIndex boundary=$boundaryReason capturedAt=$clipStartedAtWallClockMs durationMs=$clipDuration voicedMs=$clipVoicedMs silenceMs=$silenceDuration bytes=${wav.size}",
        )

        try {
          onClip(
            CapturedAudioClip(
              bytes = wav,
              fileName = "capture-${System.currentTimeMillis()}.wav",
              capturedAt = clipStartedAtWallClockMs,
              durationMs = clipDuration,
              note = note,
            ),
          )
        } catch (error: Throwable) {
          if (error is CancellationException) {
            throw error
          }
          Log.e(tag, "Audio clip callback failed", error)
        }
        lastConversationClipEndedAtElapsed = nowElapsed
        clipStartedAtElapsed = 0L
        clipStartedAtWallClockMs = 0L
        clipVoicedMs = 0L
        peakRms = 0.0
      }
    }
  }

  override suspend fun stop() {
    pendingQueryCapture = null
    withContext(Dispatchers.IO) {
      record?.runCatching {
        if (recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          stop()
        }
      }
    }
    loopJob?.cancelAndJoin()
    loopJob = null
    activeQueryCapture = null
    withContext(Dispatchers.IO) {
      record?.runCatching { release() }
      record = null
    }
  }

  private fun toPcm16Bytes(data: ShortArray, read: Int): ByteArray {
    val bytes = ByteArray(read * 2)
    var byteIndex = 0
    repeat(read) { index ->
      val sample = data[index].toInt()
      bytes[byteIndex++] = (sample and 0xFF).toByte()
      bytes[byteIndex++] = ((sample shr 8) and 0xFF).toByte()
    }
    return bytes
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

  private fun createRecorder(minBuffer: Int): AudioRecord {
    val bufferSize = maxOf(minBuffer * 2, config.readFrameSize * 2)
    val primary = AudioRecord(
      config.audioSource,
      config.sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSize,
    )
    if (primary.state == AudioRecord.STATE_INITIALIZED) {
      activeAudioSource = config.audioSource
      return primary
    }
    if (config.audioSource == MediaRecorder.AudioSource.MIC) {
      activeAudioSource = config.audioSource
      return primary
    }
    primary.release()
    Log.w(
      tag,
      "AudioRecord source ${audioSourceName(config.audioSource)} failed to initialize; falling back to MIC",
    )
    activeAudioSource = MediaRecorder.AudioSource.MIC
    return AudioRecord(
      MediaRecorder.AudioSource.MIC,
      config.sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSize,
    )
  }

  private fun bufferFrame(frames: ArrayDeque<BufferedFrame>, frame: BufferedFrame) {
    frames.addLast(frame)
    while (frames.size > config.preRollFrames) {
      frames.removeFirst()
    }
  }

  private fun totalDurationMs(frames: ArrayDeque<BufferedFrame>): Long {
    var total = 0L
    frames.forEach { total += it.durationMs }
    return total
  }

  private fun buildConversationNote(
    sessionId: String,
    segmentIndex: Int,
    sessionStartedAtMs: Long,
    clipDurationMs: Long,
    voicedDurationMs: Long,
    peakRms: Double,
    boundaryReason: String,
    continued: Boolean,
  ): String {
    return buildString {
      append("csAudio:v2")
      append(" session=").append(sessionId)
      append(" segment=").append(segmentIndex)
      append(" sessionStart=").append(sessionStartedAtMs)
      append(" boundary=").append(boundaryReason)
      append(" clipMs=").append(clipDurationMs)
      append(" voicedMs=").append(voicedDurationMs)
      append(" peakRms=").append(String.format(Locale.US, "%.3f", peakRms))
      append(" continued=").append(if (continued) 1 else 0)
    }
  }

  private data class BufferedFrame(
    val bytes: ByteArray,
    val durationMs: Long,
    val voiced: Boolean,
    val rms: Double,
  )

  private class AssistantQueryCapture(
    val onResult: suspend (CapturedAudioClip?) -> Unit,
  ) {
    private val buffer = ByteArrayOutputStream()
    private var startedAtElapsed = 0L
    private var startedAtWallClockMs = 0L
    private var lastVoiceElapsed = 0L
    var voicedMs = 0L
      private set
    var peakRms = 0.0
      private set

    fun begin(nowElapsed: Long, preRoll: Iterable<BufferedFrame>) {
      startedAtElapsed = nowElapsed
      startedAtWallClockMs = System.currentTimeMillis()
      // Include the pre-roll so words spoken right as the user taps the button survive.
      preRoll.forEach { buffered ->
        buffer.write(buffered.bytes)
        if (buffered.voiced) {
          voicedMs += buffered.durationMs
          lastVoiceElapsed = nowElapsed
        }
        peakRms = maxOf(peakRms, buffered.rms)
      }
    }

    fun acceptFrame(
      frameBytes: ByteArray,
      frameDurationMs: Long,
      rms: Double,
      nowElapsed: Long,
      config: Config,
    ): Boolean {
      buffer.write(frameBytes)
      if (rms >= config.queryVadThresholdRms) {
        voicedMs += frameDurationMs
        lastVoiceElapsed = nowElapsed
      }
      peakRms = maxOf(peakRms, rms)
      val elapsed = elapsedMs(nowElapsed)
      if (elapsed >= config.queryMaxDurationMs) {
        return true
      }
      val trailingSilenceMs = if (lastVoiceElapsed == 0L) 0L else nowElapsed - lastVoiceElapsed
      return voicedMs >= config.queryMinVoicedMs && trailingSilenceMs >= config.querySilenceTimeoutMs
    }

    fun elapsedMs(nowElapsed: Long): Long = nowElapsed - startedAtElapsed

    fun buildClip(sampleRate: Int): CapturedAudioClip? {
      if (voicedMs < MIN_DELIVERABLE_VOICED_MS) {
        return null
      }
      return CapturedAudioClip(
        bytes = WavEncoder.wrapPcm16Mono(buffer.toByteArray(), sampleRate),
        fileName = "assistant-query-${System.currentTimeMillis()}.wav",
        capturedAt = startedAtWallClockMs,
        durationMs = (buffer.size().toLong() / 2L) * 1000L / sampleRate,
        note = "assistant-query voicedMs=$voicedMs peakRms=${String.format(Locale.US, "%.3f", peakRms)}",
      )
    }

    private companion object {
      const val MIN_DELIVERABLE_VOICED_MS = 240L
    }
  }

  data class Config(
    val sampleRate: Int = 16_000,
    val readFrameSize: Int = 2048,
    // VOICE_RECOGNITION initializes fine on some devices (e.g. this Xiaomi) but
    // streams near-zero samples (peakRms~0.0003), silently killing the VAD. MIC
    // is the only source verified to deliver real audio on the target hardware.
    val audioSource: Int = MediaRecorder.AudioSource.MIC,
    val vadThresholdRms: Double = 0.012,
    val silenceTimeoutMs: Long = 2_400,
    val minClipMs: Long = 1_200,
    val minVoicedMs: Long = 650,
    val maxClipMs: Long = 60_000,
    val voiceActivationFrames: Int = 2,
    val preRollFrames: Int = 4,
    val uploadCooldownMs: Long = 400,
    val discardCooldownMs: Long = 1_500,
    val conversationContinuationGapMs: Long = 30_000,
    // Dedicated assistant-query recorder: more sensitive than the ambient VAD and
    // bounded by a hard cap so a query never waits on ambient silence heuristics.
    val queryMaxDurationMs: Long = 8_000,
    val querySilenceTimeoutMs: Long = 1_200,
    val queryMinVoicedMs: Long = 400,
    val queryVadThresholdRms: Double = 0.008,
  )

  private fun audioSourceName(source: Int): String {
    return when (source) {
      MediaRecorder.AudioSource.MIC -> "MIC"
      MediaRecorder.AudioSource.VOICE_RECOGNITION -> "VOICE_RECOGNITION"
      MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "VOICE_COMMUNICATION"
      MediaRecorder.AudioSource.CAMCORDER -> "CAMCORDER"
      else -> source.toString()
    }
  }
}
