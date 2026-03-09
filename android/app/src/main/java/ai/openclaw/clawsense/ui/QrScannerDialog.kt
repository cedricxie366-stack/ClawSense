package ai.openclaw.clawsense.ui

import android.annotation.SuppressLint
import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun QrScannerDialog(
  onDismiss: () -> Unit,
  onDetected: (String) -> Unit,
) {
  Dialog(
    onDismissRequest = onDismiss,
    properties = DialogProperties(usePlatformDefaultWidth = false),
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .background(Color(0xFF0C1620), RoundedCornerShape(28.dp))
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text("对准终端里的 ASCII 二维码", style = MaterialTheme.typography.titleMedium, color = Color.White)
      Text(
        "扫码成功后会自动关闭并把引导码填回首页。",
        style = MaterialTheme.typography.bodyMedium,
        color = Color(0xFFB8C5D1),
      )
      Box(modifier = Modifier.fillMaxWidth().height(460.dp)) {
        ScannerPreview(onDetected = onDetected)
      }
      Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
        Text("关闭扫码")
      }
    }
  }
}

@SuppressLint("UnsafeOptInUsageError")
@Composable
private fun ScannerPreview(
  onDetected: (String) -> Unit,
) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val detected = remember { AtomicBoolean(false) }
  val scanner = remember {
    BarcodeScanning.getClient(
      BarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .build(),
    )
  }

  DisposableEffect(Unit) {
    onDispose { scanner.close() }
  }

  DisposableEffect(context, lifecycleOwner) {
    onDispose {
      runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
    }
  }

  AndroidView(
    modifier = Modifier.fillMaxSize(),
    factory = { ctx ->
      PreviewView(ctx).apply {
        scaleType = PreviewView.ScaleType.FILL_CENTER
        bindScannerCamera(
          context = ctx,
          previewView = this,
          lifecycleOwner = lifecycleOwner,
          scanner = scanner,
          detected = detected,
          onDetected = onDetected,
        )
      }
    },
  )
}

private fun bindScannerCamera(
  context: Context,
  previewView: PreviewView,
  lifecycleOwner: androidx.lifecycle.LifecycleOwner,
  scanner: com.google.mlkit.vision.barcode.BarcodeScanner,
  detected: AtomicBoolean,
  onDetected: (String) -> Unit,
) {
  val providerFuture = ProcessCameraProvider.getInstance(context)
  providerFuture.addListener(
    {
      val provider = providerFuture.get()
      val preview = Preview.Builder().build().apply {
        surfaceProvider = previewView.surfaceProvider
      }
      val analysis = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
      analysis.setAnalyzer(ContextCompat.getMainExecutor(context)) { proxy ->
        val mediaImage = proxy.image
        if (mediaImage == null) {
          proxy.close()
          return@setAnalyzer
        }
        val image = InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees)
        scanner.process(image)
          .addOnSuccessListener { barcodes ->
            val raw = barcodes.firstOrNull { it.rawValue?.isNotBlank() == true }?.rawValue
            if (raw != null && detected.compareAndSet(false, true)) {
              onDetected(raw)
            }
          }
          .addOnCompleteListener {
            proxy.close()
          }
      }
      provider.unbindAll()
      provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    },
    ContextCompat.getMainExecutor(context),
  )
}
