package ai.openclaw.clawsense

import ai.openclaw.clawsense.data.ClawSenseApi
import ai.openclaw.clawsense.data.DeviceSessionRepository
import ai.openclaw.clawsense.data.OkHttpClawSenseApi
import ai.openclaw.clawsense.data.SecureSessionStore
import android.content.Context
import kotlinx.serialization.json.Json

object AppGraph {
  private lateinit var appContext: Context
  private val json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  }

  @Volatile private var sessionStoreInstance: SecureSessionStore? = null
  @Volatile private var apiInstance: ClawSenseApi? = null
  @Volatile private var repositoryInstance: DeviceSessionRepository? = null

  fun initialize(context: Context) {
    appContext = context.applicationContext
  }

  fun sessionStore(context: Context = appContext): SecureSessionStore {
    return sessionStoreInstance ?: synchronized(this) {
      sessionStoreInstance ?: SecureSessionStore(context, json).also { sessionStoreInstance = it }
    }
  }

  fun api(context: Context = appContext): ClawSenseApi {
    return apiInstance ?: synchronized(this) {
      apiInstance ?: OkHttpClawSenseApi(json, context.applicationContext).also { apiInstance = it }
    }
  }

  fun repository(context: Context = appContext): DeviceSessionRepository {
    return repositoryInstance ?: synchronized(this) {
      repositoryInstance ?: DeviceSessionRepository(
        store = sessionStore(context),
        api = api(context),
      ).also { repositoryInstance = it }
    }
  }
}
