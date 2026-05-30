package ai.openclaw.clawsense.service

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

class AssistantTtsController(
  private val context: Context,
) {
  private var textToSpeech: TextToSpeech? = null
  private var activeContinuation: CancellableContinuation<Result<Unit>>? = null
  private var isReady = false
  private val mainHandler = Handler(Looper.getMainLooper())
  private val appContext = context.applicationContext

  suspend fun speak(text: String): Result<Unit> {
    val normalized = text.trim()
    if (normalized.isBlank()) {
      return Result.success(Unit)
    }
    return withContext(Dispatchers.Main.immediate) {
      val engine = ensureReady().getOrElse { return@withContext Result.failure(it) }
      suspendCancellableCoroutine { continuation ->
        val utteranceId = "clawsense-assistant-${UUID.randomUUID()}"
        activeContinuation?.takeIf { it.isActive }?.resume(Result.success(Unit))
        activeContinuation = continuation
        engine.setOnUtteranceProgressListener(
          object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit

            override fun onDone(utteranceId: String?) {
              if (activeContinuation === continuation) {
                activeContinuation = null
              }
              if (continuation.isActive) {
                continuation.resume(Result.success(Unit))
              }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
              if (activeContinuation === continuation) {
                activeContinuation = null
              }
              if (continuation.isActive) {
                continuation.resume(Result.failure(IllegalStateException("TTS 播报失败")))
              }
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
              if (activeContinuation === continuation) {
                activeContinuation = null
              }
              if (continuation.isActive) {
                continuation.resume(Result.failure(IllegalStateException("TTS 播报失败（$errorCode）")))
              }
            }
          },
        )

        val params = Bundle().apply {
          putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
        }
        val status = engine.speak(normalized, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        if (status != TextToSpeech.SUCCESS && continuation.isActive) {
          if (activeContinuation === continuation) {
            activeContinuation = null
          }
          continuation.resume(Result.failure(IllegalStateException("TTS 引擎拒绝了播报请求")))
        }
        continuation.invokeOnCancellation {
          if (activeContinuation === continuation) {
            activeContinuation = null
          }
          engine.stop()
        }
      }
    }
  }

  suspend fun stopSpeaking() {
    withContext(Dispatchers.Main.immediate) {
      textToSpeech?.stop()
      activeContinuation?.takeIf { it.isActive }?.resume(Result.success(Unit))
      activeContinuation = null
    }
  }

  suspend fun shutdown() {
    withContext(Dispatchers.Main.immediate) {
      activeContinuation?.takeIf { it.isActive }?.resume(Result.success(Unit))
      activeContinuation = null
      textToSpeech?.stop()
      textToSpeech?.shutdown()
      textToSpeech = null
      isReady = false
    }
  }

  private suspend fun ensureReady(): Result<TextToSpeech> {
    val existing = textToSpeech
    if (existing != null && isReady) {
      return Result.success(existing)
    }
    val failures = mutableListOf<String>()
    for (enginePackage in resolveTtsEngineCandidates()) {
      val result = withTimeoutOrNull(TTS_INIT_TIMEOUT_MS) {
        initializeEngine(enginePackage)
      } ?: Result.failure(IllegalStateException("TTS 初始化超时"))
      val engine = result.getOrNull()
      if (engine != null) {
        return Result.success(engine)
      }
      val label = enginePackage ?: "default"
      failures += "$label:${result.exceptionOrNull()?.message ?: "unknown"}"
    }
    return Result.failure(
      IllegalStateException(
        "TTS 初始化失败：${failures.take(4).joinToString("; ").ifBlank { "没有可用系统 TTS 引擎" }}",
      ),
    )
  }

  private suspend fun initializeEngine(enginePackage: String?): Result<TextToSpeech> {
    return suspendCancellableCoroutine { continuation ->
      var candidate: TextToSpeech? = null
      candidate = if (enginePackage.isNullOrBlank()) {
        TextToSpeech(appContext) { status ->
          handleInitStatus({ candidate }, status, { continuation.isActive }) { result ->
            if (continuation.isActive) {
              continuation.resume(result)
            }
          }
        }
      } else {
        TextToSpeech(appContext, { status ->
          handleInitStatus({ candidate }, status, { continuation.isActive }) { result ->
            if (continuation.isActive) {
              continuation.resume(result)
            }
          }
        }, enginePackage)
      }
      continuation.invokeOnCancellation {
        candidate.stop()
        candidate.shutdown()
      }
    }
  }

  private fun handleInitStatus(
    engineProvider: () -> TextToSpeech?,
    status: Int,
    isActive: () -> Boolean,
    resumeResult: (Result<TextToSpeech>) -> Unit,
  ) {
    // Some vendor TTS engines invoke the init callback before the constructor
    // assignment has completed, so hop once through the main queue before
    // touching the candidate reference.
    mainHandler.post {
      val engine = engineProvider()
      if (engine == null) {
        if (isActive()) {
          resumeResult(Result.failure(IllegalStateException("引擎未就绪")))
        }
        return@post
      }
      if (status != TextToSpeech.SUCCESS) {
        engine.shutdown()
        if (isActive()) {
          resumeResult(Result.failure(IllegalStateException("status=$status")))
        }
        return@post
      }
      configureBestEffortLanguage(engine)
      engine.setSpeechRate(1.0f)
      engine.setPitch(1.0f)
      textToSpeech = engine
      isReady = true
      if (isActive()) {
        resumeResult(Result.success(engine))
      }
    }
  }

  private fun configureBestEffortLanguage(engine: TextToSpeech) {
    val candidates = listOf(
      Locale.SIMPLIFIED_CHINESE,
      Locale.CHINESE,
      Locale.getDefault(),
      Locale.US,
    ).distinctBy { locale -> locale.toLanguageTag() }
    for (locale in candidates) {
      val status = engine.setLanguage(locale)
      if (status != TextToSpeech.LANG_MISSING_DATA && status != TextToSpeech.LANG_NOT_SUPPORTED) {
        return
      }
    }
  }

  private fun resolveTtsEngineCandidates(): List<String?> {
    val configuredDefault = runCatching {
      Settings.Secure.getString(appContext.contentResolver, "tts_default_synth")
    }.getOrNull()
    val discovered = discoverTtsEnginePackages()
    return sequenceOf(
      configuredDefault,
      "com.xiaomi.mibrain.speech",
      "com.google.android.tts",
    )
      .plus(discovered.asSequence())
      .map { value -> value?.trim() }
      .filter { value -> !value.isNullOrBlank() }
      .distinct()
      .plus(sequenceOf(null))
      .toList()
  }

  private fun discoverTtsEnginePackages(): List<String> {
    val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
    val packageManager = appContext.packageManager
    val services = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      packageManager.queryIntentServices(intent, PackageManager.ResolveInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      packageManager.queryIntentServices(intent, 0)
    }
    return services
      .mapNotNull { info -> info.serviceInfo?.packageName?.takeIf { it.isNotBlank() } }
      .distinct()
  }

  private companion object {
    const val TTS_INIT_TIMEOUT_MS = 5_000L
  }
}
