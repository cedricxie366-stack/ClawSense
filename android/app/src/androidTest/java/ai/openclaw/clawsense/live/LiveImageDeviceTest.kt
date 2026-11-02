package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.MainActivity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.ExifInterface
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayInputStream
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs

class LiveImageDeviceTest {
  @Test fun wireImageAppliesAllEightExifOrientations() {
    val context=InstrumentationRegistry.getInstrumentation().targetContext
    val colors=intArrayOf(Color.RED,Color.GREEN,Color.BLUE,Color.YELLOW)
    val expected=listOf(listOf(0,1,2,3),listOf(1,0,3,2),listOf(3,2,1,0),listOf(2,3,0,1),
      listOf(0,2,1,3),listOf(2,0,3,1),listOf(3,1,2,0),listOf(1,3,0,2))
    val source=Bitmap.createBitmap(120,80,Bitmap.Config.ARGB_8888)
    for(y in 0 until 80)for(x in 0 until 120)source.setPixel(x,y,colors[(if(y<40)0 else 2)+(if(x<60)0 else 1)])
    val file=File(context.cacheDir,"live-exif-fixture.jpg")
    val rows=mutableListOf<JsonObject>()
    ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("validationKeepScreenOn",true)).use {
      try {
        for(orientation in 1..8) {
          file.outputStream().use { source.compress(Bitmap.CompressFormat.JPEG,100,it) }
          ExifInterface(file.absolutePath).apply { setAttribute(ExifInterface.TAG_ORIENTATION,orientation.toString());saveAttributes() }
          val wire=encodeLiveJpeg(file.readBytes())
          val bitmap=BitmapFactory.decodeByteArray(wire,0,wire.size) ?: error("fixture_decode_failed")
          try {
            assertEquals(if(orientation>=5)80 else 120,bitmap.width)
            assertEquals(if(orientation>=5)120 else 80,bitmap.height)
            val points=listOf(.25 to .25,.75 to .25,.25 to .75,.75 to .75)
            for((i,point)in points.withIndex()) {
              val actual=bitmap.getPixel((bitmap.width*point.first).toInt(),(bitmap.height*point.second).toInt())
              val target=colors[expected[orientation-1][i]]
              assertTrue("Wrong EXIF $orientation corner $i",abs(Color.red(actual)-Color.red(target))<30&&abs(Color.green(actual)-Color.green(target))<30&&abs(Color.blue(actual)-Color.blue(target))<30)
            }
            val outputOrientation=ByteArrayInputStream(wire).use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION,1) }
            assertTrue("The normalized image must not rotate again",outputOrientation in listOf(ExifInterface.ORIENTATION_UNDEFINED,ExifInterface.ORIENTATION_NORMAL))
            rows.add(buildJsonObject{put("orientation",orientation);put("passed",true);put("width",bitmap.width);put("height",bitmap.height);put("wireExif",outputOrientation)})
          } finally {bitmap.recycle()}
        }
        File(context.filesDir,"live-validation").apply{mkdirs()}.resolve("image-orientations.json").writeText(buildJsonObject{
          put("cases",JsonArray(rows));put("cameraStarted",false);put("microphoneStarted",false)
        }.toString())
      } finally {source.recycle();file.delete()}
    }
  }
}
