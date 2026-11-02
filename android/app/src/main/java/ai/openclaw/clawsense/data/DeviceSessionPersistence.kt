package ai.openclaw.clawsense.data

/** Sensor-session persistence boundary; production uses encrypted preferences. */
interface DeviceSessionPersistence {
  fun loadSession(): DeviceSession?
  fun saveSession(session: DeviceSession)
  fun clearSession()
  fun loadServiceEnabled(): Boolean
  fun saveServiceEnabled(enabled: Boolean)
  fun loadRuntimeStatus(): ServiceRuntimeStatus
  fun saveRuntimeStatus(status: ServiceRuntimeStatus)
  fun loadCapturePreferences(): CapturePreferences
  fun saveCapturePreferences(preferences: CapturePreferences)
}
