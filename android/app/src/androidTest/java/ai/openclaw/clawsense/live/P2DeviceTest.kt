package ai.openclaw.clawsense.live

import ai.openclaw.clawsense.AppGraph
import ai.openclaw.clawsense.MainActivity
import ai.openclaw.clawsense.service.SensorServiceController
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import android.os.SystemClock

/** Actual Android repository/control plane + configured DSH and Codex. Synthetic customer data only. */
class P2DeviceTest {
  private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val controller get() = AppGraph.live(context)
  private val folder get() = File(context.filesDir, "live-validation").apply { mkdirs() }
  private fun await(timeout: Long = 180000, condition: () -> Boolean) {
    val end = SystemClock.elapsedRealtime() + timeout
    while (!condition() && SystemClock.elapsedRealtime() < end) Thread.sleep(80)
    assertTrue("Timed out: ${controller.state.value.error}", condition())
  }
  private fun report(name: String, value: JsonObject) { File(folder, "$name.json").writeText(value.toString()) }
  private fun rows(): List<JsonObject> = Json.parseToJsonElement(controller.state.value.workJson).jsonArray.map { it.jsonObject }
  @Test fun digitalConfirmationTwoHostsReviewOfflineAndDelete() = runBlocking {
    // A prior offline harness may have left completion markers after a failed run.
    for (name in listOf("offline-now", "online-now", "p2-offline-ready.json", "p2-offline-observed.json", "p2-story.json")) File(folder, name).delete()
    val digital = AppGraph.digital(context)
    val code = File(folder, "setup-primary-code")
    if (code.exists()) { digital.pair(code.readText()); code.delete() }
    assertNotNull(digital.session())
    SensorServiceController.stop(context); controller.disconnect()
    ActivityScenario.launch(MainActivity::class.java).use {
      val person = digital.createPerson("测试客户小陈", "live")
      val encounter = digital.createEncounter("P2 展会后线上确认", "live")
      val draft = digital.createText("测试客户小陈在聊天中明确：改为周四收到方案，预算四万元。", "P2 选定聊天片段")
      digital.inbox.saveDraft(draft.copy(projectId = "live", personId = person["personId"]!!.jsonPrimitive.content, sessionId = encounter["sessionId"]!!.jsonPrimitive.content))
      digital.queue(draft.id); assertTrue(digital.sync())
      val imported = digital.refresh()["events"]!!.jsonArray.map { row -> row.jsonObject }.first { row -> row["clientEventId"]?.jsonPrimitive?.content == draft.id }
      val fact = "测试客户小陈希望周四收到方案，预算四万元。"
      digital.confirmFact(imported, encounter, fact)
      controller.connect(); await { controller.state.value.connected }
      val firstTurn = controller.state.value.turnId; controller.text("小陈希望什么时候收到方案？"); await { controller.state.value.turnCompleted && controller.state.value.turnId != firstTurn }; assertTrue(controller.state.value.answer.contains("周四"))
      val outputs = mutableListOf<JsonObject>(); val runId = java.util.UUID.randomUUID().toString().take(8)
      for ((agent, filename) in listOf("dsh" to "p2-phone-dsh-$runId.md", "codex" to "p2-phone-codex-$runId.md")) {
        controller.text("写一个 $filename 文件，正文为：测试客户小陈周四收到方案，预算四万元。只保存，不发送。完成后回复文件名。", agent = agent)
        await { rows().any { row -> row["status"]?.jsonPrimitive?.content == "completed" && row["files"]?.jsonArray.orEmpty().any { f -> f.jsonObject["name"]?.jsonPrimitive?.content == filename } } }
        val result = rows().first { row -> row["files"]?.jsonArray.orEmpty().any { f -> f.jsonObject["name"]?.jsonPrimitive?.content == filename } }
        val content = result["files"]!!.jsonArray.first { f -> f.jsonObject["name"]!!.jsonPrimitive.content == filename }.jsonObject["content"]!!.jsonPrimitive.content
        assertTrue(content.contains("周四") && content.contains("四万元"))
        digital.reviewResult(result["resultId"]!!.jsonPrimitive.content, result["reviewRevision"]!!.jsonPrimitive.int, agent == "codex", if (agent == "codex") outputs.firstOrNull()?.get("resultId")?.jsonPrimitive?.content else null)
        outputs.add(result)
      }
      controller.disconnect(); controller.connect(); await { controller.state.value.connected }
      val reuseTurn = controller.state.value.turnId; controller.text("小陈的预算是多少？"); await { controller.state.value.turnCompleted && controller.state.value.turnId != reuseTurn }; assertTrue(controller.state.value.answer.contains("四万"))
      val checkpoint = digital.refresh(); assertTrue(checkpoint["memory"]!!.jsonObject["entries"]!!.jsonArray.any { row -> row.jsonObject["state"]?.jsonPrimitive?.content == "accepted-current" })
      controller.disconnect()
      report("p2-offline-ready", buildJsonObject { put("ready", true) })
      await(60000) { File(folder, "offline-now").exists() }
      digital.releaseIdleConnections()
      assertNotNull(digital.cached()); assertTrue(runCatching { digital.refresh() }.isFailure); assertNotNull(digital.cached())
      report("p2-offline-observed", buildJsonObject { put("cachedWithoutHost", true) })
      await(60000) { File(folder, "online-now").exists() }
      digital.refresh(); digital.delete(digital.inbox.get(draft.id))
      val after = digital.cached()!!; assertFalse("Deleted digital evidence reappeared", after["events"]!!.jsonArray.any { row -> row.jsonObject["eventId"] == imported["eventId"] })
      report("p2-story", buildJsonObject { put("syntheticCustomer", true); put("androidDigitalImport", true); put("ownerConfirmation", true); put("actualDshAndCodex", true); put("actualFiles", true); put("rejectedDraft", true); put("acceptedReplacement", true); put("reconnectReuse", true); put("offlineCached", true); put("deletedSourceHidden", true); put("humanSceneAccepted", false) })
    }
  }
}
