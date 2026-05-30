package ai.openclaw.clawsense.sensors

import ai.openclaw.clawsense.data.CapturedImageFrame
import ai.openclaw.clawsense.data.CapturedVideoClip
import ai.openclaw.clawsense.data.CapturedVideoKeyframe
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class CameraXImageSensorHal(
  private val context: Context,
) : ImageSensorHal {
  private val tag = "ClawSenseCamera"
  private var cameraProvider: ProcessCameraProvider? = null
  private var imageCapture: ImageCapture? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var activeRecording: Recording? = null
  private var cameraLifecycleOwner: ServiceCameraLifecycleOwner? = null
  private val videoMutex = Mutex()

  override suspend fun start() {
    ensurePermission()
    withContext(Dispatchers.Main) {
      val lifecycleOwner = ServiceCameraLifecycleOwner().also {
        it.start()
        cameraLifecycleOwner = it
      }
      val provider = awaitCameraProvider()
      cameraProvider = provider
      val imageUseCase = ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .setTargetResolution(Size(1280, 720))
        .setJpegQuality(75)
        .build()
      val recorder = Recorder.Builder()
        .setQualitySelector(
          QualitySelector.from(
            Quality.SD,
            FallbackStrategy.lowerQualityOrHigherThan(Quality.SD),
          ),
        )
        .build()
      val videoUseCase = VideoCapture.withOutput(recorder)
      provider.unbindAll()
      provider.bindToLifecycle(
        lifecycleOwner,
        CameraSelector.DEFAULT_BACK_CAMERA,
        imageUseCase,
        videoUseCase,
      )
      imageCapture = imageUseCase
      videoCapture = videoUseCase
      Log.d(tag, "CameraX bound with image+video use cases target=1280x720 jpeg=75 videoQuality=SD")
    }
  }

  override suspend fun captureStill(): CapturedImageFrame {
    return captureStillFrame(
      fileName = "snapshot-${System.currentTimeMillis()}.jpg",
      note = null,
    )
  }

  override suspend fun recordVideoClip(durationMs: Long): CapturedVideoClip {
    ensurePermission()
    val capture = videoCapture ?: run {
      start()
      videoCapture ?: error("视频相机未初始化")
    }
    val safeDurationMs = durationMs.coerceIn(2_000L, 12_000L)
    return videoMutex.withLock {
      val capturedAt = System.currentTimeMillis()
      val startFrame = runCatching {
        captureStillFrame(
          fileName = "video-keyframe-start-$capturedAt.jpg",
          note = "videoOffsetMs=0",
        )
      }
        .onFailure { Log.w(tag, "Start keyframe capture failed", it) }
        .getOrNull()
      val videoFile = File.createTempFile("clawsense-video-", ".mp4", context.cacheDir)
      val bytes = try {
        recordVideoFile(capture, videoFile, safeDurationMs)
      } finally {
        activeRecording = null
      }
      val endFrame = runCatching {
        captureStillFrame(
          fileName = "video-keyframe-end-$capturedAt.jpg",
          note = "videoOffsetMs=$safeDurationMs",
        )
      }
        .onFailure { Log.w(tag, "End keyframe capture failed", it) }
        .getOrNull()
      videoFile.delete()
      val keyframes = buildList {
        startFrame?.let { add(CapturedVideoKeyframe(image = it, videoOffsetMs = 0L)) }
        endFrame?.let { add(CapturedVideoKeyframe(image = it, videoOffsetMs = safeDurationMs)) }
      }
      CapturedVideoClip(
        bytes = bytes,
        fileName = "video-${capturedAt}.mp4",
        capturedAt = capturedAt,
        durationMs = safeDurationMs,
        note = "androidVideoM2=1 clipMs=$safeDurationMs keyframes=${keyframes.size}",
        keyframes = keyframes,
      )
    }
  }

  private suspend fun captureStillFrame(fileName: String, note: String?): CapturedImageFrame {
    ensurePermission()
    val capture = imageCapture ?: run {
      start()
      imageCapture ?: error("相机未初始化")
    }
    Log.d(tag, "Submitting still capture request")
    return withContext(Dispatchers.Main) {
      val file = File.createTempFile("clawsense-", ".jpg", context.cacheDir)
      suspendCancellableCoroutine { continuation ->
        val output = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(
          output,
          ContextCompat.getMainExecutor(context),
          object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
              val bytes = file.readBytes()
              file.delete()
              Log.d(tag, "Still capture saved bytes=${bytes.size}")
              continuation.resume(
                CapturedImageFrame(
                  bytes = bytes,
                  fileName = fileName,
                  capturedAt = System.currentTimeMillis(),
                  note = note,
                ),
              )
            }

            override fun onError(exception: ImageCaptureException) {
              file.delete()
              Log.e(tag, "Still capture failed", exception)
              continuation.resumeWithException(exception)
            }
          },
        )
      }
    }
  }

  private suspend fun recordVideoFile(
    capture: VideoCapture<Recorder>,
    file: File,
    durationMs: Long,
  ): ByteArray {
    Log.d(tag, "Starting video capture durationMs=$durationMs")
    return withContext(Dispatchers.Main) {
      suspendCancellableCoroutine { continuation ->
        val output = FileOutputOptions.Builder(file).build()
        val handler = Handler(Looper.getMainLooper())
        lateinit var recording: Recording
        val stopRunnable = Runnable {
          Log.d(tag, "Stopping video capture after durationMs=$durationMs")
          recording.stop()
        }
        recording = capture.output
          .prepareRecording(context, output)
          .start(ContextCompat.getMainExecutor(context)) { event ->
            when (event) {
              is VideoRecordEvent.Start -> {
                Log.d(tag, "Video capture started")
              }
              is VideoRecordEvent.Finalize -> {
                handler.removeCallbacks(stopRunnable)
                if (activeRecording === recording) {
                  activeRecording = null
                }
                if (!continuation.isActive) {
                  return@start
                }
                if (event.hasError()) {
                  file.delete()
                  val cause = event.cause
                  continuation.resumeWithException(
                    IOException("视频录制失败：${event.error}", cause),
                  )
                } else {
                  val bytes = file.readBytes()
                  Log.d(tag, "Video capture finalized bytes=${bytes.size}")
                  continuation.resume(bytes)
                }
              }
            }
          }
        activeRecording = recording
        handler.postDelayed(stopRunnable, durationMs)
        continuation.invokeOnCancellation {
          handler.removeCallbacks(stopRunnable)
          runCatching { recording.stop() }
          file.delete()
        }
      }
    }
  }

  override suspend fun stop() {
    withContext(Dispatchers.Main) {
      cameraProvider?.unbindAll()
      imageCapture = null
      runCatching { activeRecording?.stop() }
      activeRecording = null
      videoCapture = null
      cameraProvider = null
      cameraLifecycleOwner?.stop()
      cameraLifecycleOwner = null
      Log.d(tag, "CameraX unbound")
    }
  }

  private suspend fun awaitCameraProvider(): ProcessCameraProvider {
    return suspendCancellableCoroutine { continuation ->
      val future = ProcessCameraProvider.getInstance(context)
      future.addListener(
        { continuation.resume(future.get()) },
        ContextCompat.getMainExecutor(context),
      )
    }
  }

  private fun ensurePermission() {
    check(
      ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED,
    ) { "缺少相机权限" }
  }

  private class ServiceCameraLifecycleOwner : LifecycleOwner {
    private val registry = LifecycleRegistry(this)

    override val lifecycle: Lifecycle
      get() = registry

    fun start() {
      registry.currentState = Lifecycle.State.CREATED
      registry.currentState = Lifecycle.State.STARTED
      registry.currentState = Lifecycle.State.RESUMED
    }

    fun stop() {
      registry.currentState = Lifecycle.State.DESTROYED
    }
  }
}
