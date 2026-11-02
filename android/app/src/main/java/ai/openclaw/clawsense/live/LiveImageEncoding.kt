package ai.openclaw.clawsense.live

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** Apply camera orientation before removing EXIF and resizing the wire image. */
internal fun encodeLiveJpeg(bytes: ByteArray): ByteArray {
  val orientation = ByteArrayInputStream(bytes).use {
    ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
  }
  val matrix = Matrix().apply {
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(270f); postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
    }
  }
  val bitmaps = linkedSetOf<Bitmap>()
  try {
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("invalid_frame")
    bitmaps.add(decoded)
    val oriented = if (matrix.isIdentity) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    bitmaps.add(oriented)
    val scale = minOf(1.0, 768.0 / maxOf(oriented.width, oriented.height))
    val resized = Bitmap.createScaledBitmap(oriented, (oriented.width * scale).toInt().coerceAtLeast(1), (oriented.height * scale).toInt().coerceAtLeast(1), true)
    bitmaps.add(resized)
    val output = ByteArrayOutputStream()
    check(resized.compress(Bitmap.CompressFormat.JPEG, 65, output))
    check(output.size() <= 200000)
    return output.toByteArray()
  } finally { bitmaps.forEach { it.recycle() } }
}
