package ai.openclaw.clawsense.ui

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
import androidx.compose.foundation.layout.heightIn
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
import androidx.lifecycle.compose.LocalLifecycleOwner
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
        .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(24.dp))
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text("对准电脑上的配对二维码", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
      Text(
        "识别后会返回连接页面，请检查并确认连接。",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Box(modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 340.dp).weight(1f, fill = false)) {
        ScannerPreview(onDetected = onDetected)
      }
      Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
        Text("关闭扫码")
      }
    }
  }
}

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

@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
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
