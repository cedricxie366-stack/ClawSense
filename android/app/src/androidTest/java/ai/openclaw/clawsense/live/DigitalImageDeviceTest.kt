package ai.openclaw.clawsense.live
import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.digital.InboxItem
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

class DigitalImageDeviceTest {
  @Test fun localMaskCropAndChineseOcrNeverReuseOldText() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val repository = AppGraph.digital(context)
    val image = Bitmap.createBitmap(900,600,Bitmap.Config.ARGB_8888)
    val canvas = Canvas(image); canvas.drawColor(Color.WHITE)
    val paint = Paint().apply { color = Color.BLACK; textSize = 54f; isAntiAlias = true }
    canvas.drawText("测试客户小陈",30f,100f,paint); canvas.drawText("周四收到方案",30f,200f,paint); canvas.drawText("预算四万元",30f,300f,paint)
    val bytes = ByteArrayOutputStream().also { image.compress(Bitmap.CompressFormat.JPEG,95,it) }.toByteArray(); image.recycle()
    val original = repository.inbox.create(InboxItem(sourceType="shared_image",title="合成截图",text="旧识别文字不应沿用",mime="image/jpeg"),bytes)
    val masked = repository.editImage(original.id,.75f,.75f,1f,1f,true)
    assertEquals("",masked.text); assertFalse(repository.inbox.imageFile(original.id).exists())
    val preview = android.graphics.BitmapFactory.decodeFile(repository.inbox.imageFile(masked.id).path)
    assertTrue(Color.red(preview.getPixel(850,550))<15); preview.recycle()
    val recognized = repository.recognize(masked.id)
    assertTrue(recognized.text.contains("周四") && recognized.text.contains("预算") && recognized.text.contains("万元"))
    val cropped = repository.editImage(masked.id,0f,0f,.70f,.65f,false)
    assertEquals("",cropped.text); val crop = android.graphics.BitmapFactory.decodeFile(repository.inbox.imageFile(cropped.id).path)
    assertTrue(crop.width<900 && crop.height<600); crop.recycle()
    repository.inbox.queue(cropped.id,"synthetic-unconnected-target")
    assertTrue(runCatching { repository.editImage(cropped.id,0f,0f,1f,1f,false) }.isFailure)
    repository.inbox.remove(cropped.id)
    val folder=File(context.filesDir,"live-validation").apply {mkdirs()}
    File(folder,"local-image-edit.json").writeText(buildJsonObject {put("nativeAndroidBitmap",true);put("nativeChineseOcr",true);put("maskAppliedBeforeUpload",true);put("oldOcrCleared",true);put("queuedImageImmutable",true);put("syntheticImage",true);put("humanShareAccepted",false)}.toString())
  }
}
