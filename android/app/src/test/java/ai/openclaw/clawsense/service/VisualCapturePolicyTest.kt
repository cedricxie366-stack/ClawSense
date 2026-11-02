package ai.openclaw.clawsense.service

import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class VisualCapturePolicyTest {
  @After fun reset() { SensorServiceController.configureDebugImageOnly(false) }
  @Test fun visualOnlyDisallowsMicrophoneEvenWhenSystemGrantsIt() {
    assertFalse(isPermissionAllowedForCapture("android.permission.RECORD_AUDIO", true, true))
  }
  @Test fun visualOnlyPreservesCameraGrantWithoutInventingPermission() {
    assertTrue(isPermissionAllowedForCapture("android.permission.CAMERA", true, true))
    assertFalse(isPermissionAllowedForCapture("android.permission.CAMERA", false, true))
  }
  @Test fun normalModeKeepsTheActualPermissionDecision() {
    assertTrue(isPermissionAllowedForCapture("android.permission.RECORD_AUDIO", true, false))
    assertFalse(isPermissionAllowedForCapture("android.permission.RECORD_AUDIO", false, false))
  }
  @Test fun validationPolicyDoesNotLeakIntoTheNextService() {
    SensorServiceController.configureDebugImageOnly(true)
    assertTrue(SensorServiceController.consumeDebugImageOnly())
    assertFalse(SensorServiceController.consumeDebugImageOnly())
  }
}
