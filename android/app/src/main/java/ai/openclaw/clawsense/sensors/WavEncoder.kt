package ai.openclaw.clawsense.sensors

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

object WavEncoder {
  fun wrapPcm16Mono(pcmData: ByteArray, sampleRate: Int): ByteArray {
    val out = ByteArrayOutputStream(44 + pcmData.size)
    val byteRate = sampleRate * 2
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray())
      putInt(36 + pcmData.size)
      put("WAVE".toByteArray())
      put("fmt ".toByteArray())
      putInt(16)
      putShort(1)
      putShort(1)
      putInt(sampleRate)
      putInt(byteRate)
      putShort(2)
      putShort(16)
      put("data".toByteArray())
      putInt(pcmData.size)
    }.array()
    out.write(header)
    out.write(pcmData)
    return out.toByteArray()
  }
}
