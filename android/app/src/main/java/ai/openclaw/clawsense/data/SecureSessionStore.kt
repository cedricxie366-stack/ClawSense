package ai.openclaw.clawsense.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class SecureSessionStore(
  context: Context,
  private val json: Json,
) : DeviceSessionPersistence {
  private val prefs: SharedPreferences by lazy {
    val masterKey = MasterKey.Builder(context)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
    EncryptedSharedPreferences.create(
      context,
      PREFS_NAME,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }

  override fun loadSession(): DeviceSession? {
    val raw = prefs.getString(KEY_SESSION, null) ?: return null
    return runCatching { json.decodeFromString<DeviceSession>(raw) }.getOrNull()
  }

  override fun saveSession(session: DeviceSession) {
    prefs.edit().putString(KEY_SESSION, json.encodeToString(session)).apply()
  }

  override fun clearSession() {
    prefs.edit().remove(KEY_SESSION).apply()
  }

  fun loadPrimarySession(): DeviceSession? = prefs.getString("primary_device_session", null)?.let {
    runCatching { json.decodeFromString<DeviceSession>(it) }.getOrNull()
  }

  fun savePrimarySession(session: DeviceSession) {
    prefs.edit().putString("primary_device_session", json.encodeToString(session)).apply()
  }

  fun primaryFingerprint(): String {
    return prefs.getString("primary_install_id", null) ?: ("primary-" + java.util.UUID.randomUUID()).also {
      prefs.edit().putString("primary_install_id", it).commit()
    }
  }

  override fun loadServiceEnabled(): Boolean = prefs.getBoolean(KEY_SERVICE_ENABLED, false)

  override fun saveServiceEnabled(enabled: Boolean) {
    prefs.edit().putBoolean(KEY_SERVICE_ENABLED, enabled).apply()
  }

  override fun loadRuntimeStatus(): ServiceRuntimeStatus {
    val raw = prefs.getString(KEY_RUNTIME_STATUS, null)
      ?: return ServiceRuntimeStatus()
    return runCatching { json.decodeFromString<ServiceRuntimeStatus>(raw) }
      .getOrElse { ServiceRuntimeStatus() }
  }

  override fun saveRuntimeStatus(status: ServiceRuntimeStatus) {
    prefs.edit().putString(KEY_RUNTIME_STATUS, json.encodeToString(status)).apply()
  }

  override fun loadCapturePreferences(): CapturePreferences {
    val raw = prefs.getString(KEY_CAPTURE_PREFERENCES, null)
      ?: return CapturePreferences()
    return runCatching { json.decodeFromString<CapturePreferences>(raw) }
      .getOrElse { CapturePreferences() }
  }

  override fun saveCapturePreferences(preferences: CapturePreferences) {
    prefs.edit().putString(KEY_CAPTURE_PREFERENCES, json.encodeToString(preferences)).apply()
  }

  companion object {
    private const val PREFS_NAME = "clawsense_secure_prefs"
    private const val KEY_SESSION = "device_session"
    private const val KEY_SERVICE_ENABLED = "service_enabled"
    private const val KEY_RUNTIME_STATUS = "service_runtime_status"
    private const val KEY_CAPTURE_PREFERENCES = "capture_preferences"
  }
}
