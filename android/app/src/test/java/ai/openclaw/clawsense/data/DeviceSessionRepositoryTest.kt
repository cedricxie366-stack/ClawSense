package ai.openclaw.clawsense.data

import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class DeviceSessionRepositoryTest {
  private val firstSession = DeviceSession("http://first", "first-device", "first-secret-test", "http://first/api/clawsense", 60, "test", 1)
  private val secondSession = firstSession.copy(host = "http://second", deviceId = "second-device", deviceSecret = "second-secret-test", uploadBaseUrl = "http://second/api/clawsense")
  private val image = CapturedImageFrame(byteArrayOf(1, 2, 3), capturedAt = 100, fileName = "first.jpg")
  private val audio = CapturedAudioClip(byteArrayOf(4, 5, 6), capturedAt = 200, fileName = "second.wav")

  @Test fun savesConcurrentCaptureBeforeWaitingForNetworkAndSurvivesCancellation() = runBlocking {
    val root = Files.createTempDirectory("clawsense-repository-").toFile()
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    val api = object : TestApi() {
      override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame): IngestUploadResult {
        entered.complete(Unit); release.await(); return IngestUploadResult()
      }
    }
    val spool = PendingUploadSpool(root); val store = MemoryStore(firstSession)
    val repository = DeviceSessionRepository(store, api, spool)
    val first = launch(Dispatchers.Default) { repository.uploadImage(image) }
    var second: Job? = null
    try {
      withTimeout(2000) { entered.await() }
      second = launch(Dispatchers.Default) { repository.uploadAudio(audio) }
      withTimeout(2000) { while (spool.size < 2) delay(10) }
      second.cancelAndJoin(); first.cancelAndJoin()
      val restored = PendingUploadSpool(root)
      assertEquals(2, restored.restore(firstSession).restored)
      val original = restored.firstOrNull()!!
      assertArrayEquals(image.bytes, (original.upload as PendingUpload.Image).image.bytes)
      restored.acknowledge(original.id, true)
      assertArrayEquals(audio.bytes, (restored.firstOrNull()!!.upload as PendingUpload.Audio).clip.bytes)
    } finally { second?.cancelAndJoin(); first.cancelAndJoin(); root.deleteRecursively() }
  }

  @Test fun doesNotSendNewPairingMediaToAnOlderInFlightConnection() = pairingDuringUpload(false)
  @Test fun oldConnectionUnauthorizedDoesNotDisableTheNewPairing() = pairingDuringUpload(true)

  @Test fun tombstoneAcknowledgementDropsOnlyTheDeletedUploadAndContinues() = runBlocking {
    val root = Files.createTempDirectory("clawsense-deleted-upload-").toFile()
    val api = object : TestApi() {
      override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame): IngestUploadResult = throw ClawSenseDeletedCaptureException("deleted")
    }
    try {
      val spool = PendingUploadSpool(root)
      val repository = DeviceSessionRepository(MemoryStore(firstSession), api, spool)
      repository.uploadImage(image)
      assertEquals(0, spool.size)
      assertNull(repository.activitySnapshot.value.lastImageUploadAt)
      assertTrue(repository.activitySnapshot.value.lastError.orEmpty().contains("本机补传副本已清除"))
      repository.uploadAudio(audio)
      assertEquals(0, spool.size)
      assertNotNull(repository.activitySnapshot.value.lastAudioUploadAt)
    } finally { root.deleteRecursively() }
  }

  @Test fun unavailableSnapshotIsRejectedBeforeAnswerPublication() = runBlocking {
    val root = Files.createTempDirectory("clawsense-cache-validation-").toFile()
    val api = object : TestApi() {
      override suspend fun queryAssistant(session: DeviceSession, request: AssistantQueryRequest) = AssistantQueryResponse(answerText = "must not be displayed", answerSpokenText = "must not be spoken", contextSnapshotId = "context-test")
      override suspend fun validateCachedContext(session: DeviceSession, snapshotId: String) = ContextCacheValidation(snapshotId, "unavailable")
    }
    try {
      val repository = DeviceSessionRepository(MemoryStore(firstSession), api, PendingUploadSpool(root))
      assertTrue(runCatching { repository.queryAssistant(audio) }.exceptionOrNull() is IllegalStateException)
      assertNull(repository.assistantSnapshot.value.answerText)
    } finally { root.deleteRecursively() }
  }
  @Test fun correctedSnapshotCannotPublishAnOldAnswer() = runBlocking {
    val root = Files.createTempDirectory("clawsense-cache-stale-").toFile()
    val api = object : TestApi() {
      override suspend fun queryAssistant(session: DeviceSession, request: AssistantQueryRequest) = AssistantQueryResponse(answerText = "旧日期周五", answerSpokenText = "旧日期周五", contextSnapshotId = "context-old-version")
      override suspend fun validateCachedContext(session: DeviceSession, snapshotId: String) = ContextCacheValidation(snapshotId, "stale")
    }
    try {
      val repository = DeviceSessionRepository(MemoryStore(firstSession), api, PendingUploadSpool(root))
      assertTrue(runCatching { repository.queryAssistant(audio) }.exceptionOrNull() is IllegalStateException)
      assertNull(repository.assistantSnapshot.value.answerText)
    } finally { root.deleteRecursively() }
  }

  @Test fun pairingChangedDuringCacheValidationDoesNotReturnOldAnswer() = runBlocking {
    val root = Files.createTempDirectory("clawsense-cache-repair-").toFile()
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    val api = object : TestApi() {
      override suspend fun queryAssistant(session: DeviceSession, request: AssistantQueryRequest) = AssistantQueryResponse(answerText = "old host answer", answerSpokenText = "old host answer", contextSnapshotId = "context-old")
      override suspend fun validateCachedContext(session: DeviceSession, snapshotId: String): ContextCacheValidation { entered.complete(Unit); release.await(); return ContextCacheValidation(snapshotId, "current") }
    }
    val store = MemoryStore(firstSession)
    val repository = DeviceSessionRepository(store, api, PendingUploadSpool(root))
    val request = async(Dispatchers.Default) { runCatching { repository.queryAssistant(audio) } }
    try { withTimeout(2000) { entered.await() }; store.saveSession(secondSession); repository.refresh(); release.complete(Unit); assertTrue(request.await().exceptionOrNull() is CancellationException); assertEquals(secondSession, repository.session.value) }
    finally { release.complete(Unit); request.cancelAndJoin(); root.deleteRecursively() }
  }

  @Test fun deferredAudioIsDurableWhileAnotherUploadIsStalled() = runBlocking {
    val root = Files.createTempDirectory("clawsense-deferred-").toFile()
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    val api = object : TestApi() {
      override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame): IngestUploadResult {
        entered.complete(Unit); release.await(); return IngestUploadResult()
      }
    }
    val spool = PendingUploadSpool(root)
    val repository = DeviceSessionRepository(MemoryStore(firstSession), api, spool)
    val first = launch(Dispatchers.Default) { repository.uploadImage(image) }
    try {
      withTimeout(2000) { entered.await() }
      withTimeout(2000) { repository.deferAudioUpload(audio, "test backpressure") }
      first.cancelAndJoin()
      val restored = PendingUploadSpool(root)
      assertEquals(2, restored.restore(firstSession).restored)
      val original = restored.firstOrNull()!!
      restored.acknowledge(original.id, true)
      assertArrayEquals(audio.bytes, (restored.firstOrNull()!!.upload as PendingUpload.Audio).clip.bytes)
      assertTrue(repository.activitySnapshot.value.lastError.orEmpty().contains("test backpressure"))
    } finally { first.cancelAndJoin(); root.deleteRecursively() }
  }

  @Test fun delayedOldHeartbeatUnauthorizedDoesNotEraseNewPairingQueue() = runBlocking {
    val root = Files.createTempDirectory("clawsense-repository-").toFile()
    val heartbeatEntered = CompletableDeferred<Unit>(); val heartbeatRelease = CompletableDeferred<Unit>()
    val uploadEntered = CompletableDeferred<Unit>(); val uploadRelease = CompletableDeferred<Unit>()
    val api = object : TestApi() {
      override suspend fun sendHeartbeat(session: DeviceSession, heartbeat: HeartbeatRequest): HeartbeatResult {
        heartbeatEntered.complete(Unit); heartbeatRelease.await(); throw ClawSenseAuthException("old heartbeat credential expired")
      }
      override suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip): IngestUploadResult {
        uploadEntered.complete(Unit); uploadRelease.await(); return IngestUploadResult()
      }
    }
    val store = MemoryStore(firstSession); val spool = PendingUploadSpool(root)
    val repository = DeviceSessionRepository(store, api, spool)
    val heartbeat = launch(Dispatchers.Default) { runCatching { repository.sendHeartbeat(HeartbeatRequest()) } }
    var upload: Job? = null
    try {
      withTimeout(2000) { heartbeatEntered.await() }
      store.saveSession(secondSession); repository.refresh()
      upload = launch(Dispatchers.Default) { repository.uploadAudio(audio) }
      withTimeout(2000) { uploadEntered.await() }
      heartbeatRelease.complete(Unit)
      withTimeout(2000) { heartbeat.join() }
      assertEquals(secondSession, repository.session.value)
      assertTrue(repository.serviceEnabled.value)
      assertEquals(1, spool.size)
      assertEquals(1, PendingUploadSpool(root).restore(secondSession).restored)
    } finally { heartbeatRelease.complete(Unit); upload?.cancelAndJoin(); heartbeat.cancelAndJoin(); root.deleteRecursively() }
  }

  private fun pairingDuringUpload(oldUnauthorized: Boolean) = runBlocking {
    val root = Files.createTempDirectory("clawsense-repository-").toFile()
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    val sentTo = java.util.Collections.synchronizedList(mutableListOf<String>())
    val api = object : TestApi() {
      override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame): IngestUploadResult {
        sentTo.add(session.deviceId + ":image"); entered.complete(Unit); release.await()
        if (oldUnauthorized) throw ClawSenseAuthException("old credential expired")
        return IngestUploadResult()
      }
      override suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip): IngestUploadResult {
        sentTo.add(session.deviceId + ":audio"); return IngestUploadResult()
      }
    }
    val spool = PendingUploadSpool(root); val store = MemoryStore(firstSession)
    val repository = DeviceSessionRepository(store, api, spool)
    val first = launch(Dispatchers.Default) { runCatching { repository.uploadImage(image) } }
    var second: Job? = null
    try {
      withTimeout(2000) { entered.await() }
      store.saveSession(secondSession); repository.refresh()
      second = launch(Dispatchers.Default) { repository.uploadAudio(audio) }
      withTimeout(2000) { while (spool.firstOrNull()?.upload !is PendingUpload.Audio) delay(10) }
      release.complete(Unit)
      withTimeout(2000) { first.join(); second.join() }
      assertEquals(listOf("first-device:image", "second-device:audio"), sentTo)
      assertEquals(secondSession, repository.session.value)
      assertTrue(repository.serviceEnabled.value)
      assertEquals(0, spool.size)
    } finally { release.complete(Unit); second?.cancelAndJoin(); first.cancelAndJoin(); root.deleteRecursively() }
  }

  private class MemoryStore(private var saved: DeviceSession?) : DeviceSessionPersistence {
    private var enabled = true
    private var runtime = ServiceRuntimeStatus()
    private var preferences = CapturePreferences()
    override fun loadSession() = saved
    override fun saveSession(session: DeviceSession) { saved = session }
    override fun clearSession() { saved = null }
    override fun loadServiceEnabled() = enabled
    override fun saveServiceEnabled(enabled: Boolean) { this.enabled = enabled }
    override fun loadRuntimeStatus() = runtime
    override fun saveRuntimeStatus(status: ServiceRuntimeStatus) { runtime = status }
    override fun loadCapturePreferences() = preferences
    override fun saveCapturePreferences(preferences: CapturePreferences) { this.preferences = preferences }
  }
  private open class TestApi : ClawSenseApi {
    override suspend fun pair(host: String, token: String, deviceName: String, appVersion: String, fingerprint: String): DeviceSession = error("Not used")
    override suspend fun uploadAudio(session: DeviceSession, clip: CapturedAudioClip) = IngestUploadResult()
    override suspend fun uploadImage(session: DeviceSession, image: CapturedImageFrame) = IngestUploadResult()
    override suspend fun uploadVideo(session: DeviceSession, clip: CapturedVideoClip) = IngestUploadResult()
    override suspend fun queryAssistant(session: DeviceSession, request: AssistantQueryRequest): AssistantQueryResponse = error("Not used")
    override suspend fun sendHeartbeat(session: DeviceSession, heartbeat: HeartbeatRequest) = HeartbeatResult(60)
  }
}
