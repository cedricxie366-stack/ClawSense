package ai.openclaw.clawsense.sensors

import ai.openclaw.clawsense.data.CapturedAudioClip

interface AudioSensorHal {
  suspend fun start(onClip: suspend (CapturedAudioClip) -> Unit)

  suspend fun stop()
}
