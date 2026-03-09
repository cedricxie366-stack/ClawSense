package ai.openclaw.clawsense.sensors

import ai.openclaw.clawsense.data.CapturedImageFrame
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import java.io.File
import kotlinx.coroutines.Dispatchers
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
  private var cameraLifecycleOwner: ServiceCameraLifecycleOwner? = null

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
      provider.unbindAll()
      provider.bindToLifecycle(
        lifecycleOwner,
        CameraSelector.DEFAULT_BACK_CAMERA,
        imageUseCase,
      )
      imageCapture = imageUseCase
      Log.d(tag, "CameraX bound with dedicated lifecycle owner target=1280x720 jpeg=75")
    }
  }

  override suspend fun captureStill(): CapturedImageFrame {
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
                  fileName = "snapshot-${System.currentTimeMillis()}.jpg",
                  capturedAt = System.currentTimeMillis(),
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

  override suspend fun stop() {
    withContext(Dispatchers.Main) {
      cameraProvider?.unbindAll()
      imageCapture = null
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
