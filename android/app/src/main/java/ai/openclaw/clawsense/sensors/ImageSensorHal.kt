package ai.openclaw.clawsense.sensors

import ai.openclaw.clawsense.data.CapturedImageFrame
import ai.openclaw.clawsense.data.CapturedVideoClip

interface ImageSensorHal {
  suspend fun start()

  suspend fun captureStill(): CapturedImageFrame

  suspend fun recordVideoClip(durationMs: Long): CapturedVideoClip

  suspend fun stop()
}
