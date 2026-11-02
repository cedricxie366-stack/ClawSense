package ai.openclaw.clawsense.ui

import ai.openclaw.clawsense.MainUiState
import ai.openclaw.clawsense.data.*
import ai.openclaw.clawsense.digital.*
import ai.openclaw.clawsense.ui.screens.*
import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class AppUiTest {
  @get:Rule val compose = createComposeRule()
  private val granted = PermissionSnapshot(true, true, true)
  private val session = DeviceSession("http://fixture.local:18789", "fixture-device", "not-a-real-secret", "http://fixture.local:18789/api/clawsense", 60, "fixture", 0)
  private val running = MainUiState(session = session, runtimeStatus = ServiceRuntimeStatus(ServicePhase.RUNNING, CaptureMode.FULL))

  @Composable private fun Fixture(dark: Boolean = false, fontScale: Float = 1f, uiState: MainUiState = running) {
    CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
      ClawSenseTheme(dark) {
        val nav = rememberAppNavigation()
        val holder = rememberSaveableStateHolder()
        AppScaffold(nav, speaking = uiState.assistant.phase == AssistantInteractionPhase.SPEAKING_ANSWER) { padding ->
          Box(Modifier.fillMaxSize().padding(padding)) {
            holder.SaveableStateProvider(nav.tab.name + nav.destination.name) {
              if (nav.destination != AppDestination.HOME) Text(nav.destination.title) else when (nav.tab) {
                AppTab.ASSISTANT -> AssistantScreen(uiState, granted, false, { nav.open(it) }, {}, {}, {})
                AppTab.SENSING -> SensingScreen(uiState, granted, null, {}, {}, {}, { nav.open(it) })
                AppTab.SETTINGS -> SettingsScreen(uiState, null) { nav.open(it) }
                AppTab.MEMORY -> MemoryScreen(DigitalUiState(loaded = true), {}, {}, {}, {}, {}, {}, { nav.open(AppDestination.DIGITAL_CONNECTION) })
              }
            }
          }
        }
      }
    }
  }
  private fun screenshot(name: String) {
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(500)
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val dir = File(context.getExternalFilesDir(null), "ui-validation").apply { mkdirs() }
    File(dir, "$name.png").outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
  }
  @Test fun fourTabsAreReachableAndDetailReturnsToItsOwner() {
    compose.setContent { Fixture() }
    compose.onNodeWithTag("assistant_primary").assertIsDisplayed()
    screenshot("assistant-light")
    compose.onNodeWithTag("tab_memory").performClick(); compose.onNodeWithTag("screen_memory").assertIsDisplayed()
    screenshot("memory-light")
    compose.onNodeWithTag("tab_sensing").performClick(); compose.onNodeWithTag("sensing_primary").assertIsDisplayed()
    screenshot("sensing-light")
    compose.onNodeWithTag("tab_settings").performClick(); screenshot("settings-light")
    compose.onNodeWithText("感知设备连接").performClick()
    compose.onNodeWithContentDescription("返回").performClick()
    compose.onNodeWithTag("screen_settings").assertIsDisplayed()
  }
  @Test fun modeAndMemorySearchSurviveTabSwitchAndRecreation() {
    val restoration = StateRestorationTester(compose)
    restoration.setContent { Fixture() }
    compose.onNodeWithText("会议").performClick()
    compose.onNodeWithTag("tab_memory").performClick()
    compose.onNodeWithText("已同步").performClick()
    compose.onNodeWithText("关键词、项目或人物").performTextInput("项目甲")
    compose.onNodeWithTag("tab_assistant").performClick()
    compose.onNodeWithText("会议").assertIsSelected()
    compose.onNodeWithTag("tab_memory").performClick()
    compose.onNodeWithText("项目甲").assertExists()
    restoration.emulateSavedInstanceStateRestore()
    compose.onNodeWithTag("screen_memory").assertIsDisplayed()
    compose.onNodeWithText("项目甲").assertExists()
  }
  @Test fun longAnswerNeverPushesVoiceControlOffScreen() {
    val state = running.copy(assistant = AssistantInteractionSnapshot(phase = AssistantInteractionPhase.WAKEWORD_ARMED, queryText = "刚才讨论了哪些重点？", answerText = "会议明确了下周的交付安排，需要确认设计与开发时间。\n\n".repeat(100)))
    compose.setContent { Fixture(uiState = state) }
    compose.onNodeWithTag("assistant_primary").assertIsDisplayed().assertIsEnabled()
    screenshot("assistant-long-answer")
  }
  @Test fun darkLargeTypeKeepsNavigationAndPrimaryActionsVisible() {
    compose.setContent { Fixture(dark = true, fontScale = 2f) }
    compose.onNodeWithTag("assistant_primary").assertIsDisplayed()
    compose.onNodeWithTag("tab_sensing").assertIsDisplayed().performClick()
    compose.onNodeWithTag("sensing_primary").assertIsDisplayed()
    screenshot("sensing-dark-large-type")
  }
  @Test fun unpairedAppCanUseMemoryAndOffersConnectionInAssistant() {
    compose.setContent { Fixture(uiState = MainUiState()) }
    compose.onNodeWithTag("assistant_primary").assertIsDisplayed().assertIsEnabled()
    compose.onNodeWithTag("tab_memory").performClick()
    compose.onNodeWithText("添加").performClick()
    compose.onNodeWithText("新建笔记").assertIsDisplayed().assertIsEnabled()
  }
  @Test fun recordingDisablesDuplicateQueriesAndSpeakingExposesStopAcrossTabs() {
    var state by mutableStateOf(running.copy(assistant = AssistantInteractionSnapshot(phase = AssistantInteractionPhase.RECORDING_QUERY)))
    compose.setContent { Fixture(uiState = state) }
    compose.onNodeWithTag("assistant_primary").assertIsNotEnabled()
    compose.runOnIdle { state = running.copy(assistant = AssistantInteractionSnapshot(phase = AssistantInteractionPhase.SPEAKING_ANSWER)) }
    compose.onNodeWithText("停止朗读").assertIsEnabled()
    compose.onNodeWithTag("tab_memory").performClick()
    compose.onNodeWithText("停止朗读").assertIsDisplayed().assertIsEnabled()
  }
  @Test fun smallScreenKeepsTheVoiceActionReachableInDarkTheme() {
    compose.setContent { Box(Modifier.width(320.dp).height(640.dp)) { Fixture(dark = true) } }
    compose.onNodeWithTag("assistant_primary").assertIsDisplayed()
    compose.onNodeWithTag("tab_settings").assertIsDisplayed()
    screenshot("assistant-dark-small-screen")
  }
  @Test fun deniedPermissionsPresentRepairInsteadOfDisabledDeadEnd() {
    var destination: AppDestination? = null
    compose.setContent { ClawSenseTheme { AssistantScreen(running, granted.copy(microphone = false), false, { destination = it }, {}, {}, {}) } }
    compose.onNodeWithText("前往授权").performClick()
    compose.runOnIdle { assertEquals(AppDestination.PERMISSIONS, destination) }
  }
}
