package ai.openclaw.clawsense.sensors

import ai.openclaw.clawsense.data.CapturedImageFrame

interface ImageSensorHal {
  suspend fun start()

  suspend fun captureStill(): CapturedImageFrame

  suspend fun stop()
}
