@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ai.openclaw.clawsense.ui

import ai.openclaw.clawsense.*
import ai.openclaw.clawsense.data.*
import ai.openclaw.clawsense.digital.*
import ai.openclaw.clawsense.service.SensorServiceController
import ai.openclaw.clawsense.ui.screens.*
import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable internal fun ClawSenseApp(entry: AppEntry) {
  val context = LocalContext.current
  val vm = viewModel<MainViewModel>(factory = viewModelFactory { initializer { MainViewModel(AppGraph.repository(context)) } })
  val digital = viewModel<DigitalViewModel>(factory = viewModelFactory { initializer { DigitalViewModel(AppGraph.digital(context), createSavedStateHandle()) } })
  val state by vm.uiState.collectAsStateWithLifecycle()
  val liveState by AppGraph.live(context).state.collectAsStateWithLifecycle()
  val memory by digital.uiState.collectAsStateWithLifecycle()
  val nav = rememberAppNavigation()
  val stateHolder = rememberSaveableStateHolder()
  val clipboard = LocalClipboardManager.current
  val scope = rememberCoroutineScope()
  val snackbar = remember { SnackbarHostState() }
  var permissions by remember { mutableStateOf(permissionSnapshot(context)) }
  var explicitStart by rememberSaveable(entry.id) { mutableStateOf(false) }
  var pendingStart by rememberSaveable { mutableStateOf(false) }
  var queryPending by remember { mutableStateOf(false) }
  var videoPending by remember { mutableStateOf(false) }
  var scannerTarget by rememberSaveable { mutableStateOf("") }
  var pendingScanner by rememberSaveable { mutableStateOf("") }
  var digitalCode by rememberSaveable { mutableStateOf("") }
  var handledEntry by rememberSaveable { mutableStateOf("") }
  var pendingShareId by rememberSaveable { mutableStateOf<String?>(null) }
  var latestMessage by rememberSaveable { mutableStateOf("") }
  var confirmLeave by rememberSaveable { mutableStateOf(false) }
  var afterLeave by rememberSaveable { mutableStateOf("") }
  val warning = state.session?.let(::resolveSessionHostWarning)
  val hostBlocked = warning?.blocksStart == true
  val displayState = state.copy(
    assistant = if (queryPending) state.assistant.copy(phase = AssistantInteractionPhase.RECORDING_QUERY) else state.assistant,
    serviceActivity = if (videoPending) state.serviceActivity.copy(videoCaptureInProgress = true) else state.serviceActivity,
  )
  val owner = LocalLifecycleOwner.current
  DisposableEffect(owner) {
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) {
      permissions = permissionSnapshot(context); digital.reload()
    } }
    owner.lifecycle.addObserver(observer)
    onDispose { owner.lifecycle.removeObserver(observer) }
  }
  fun notify(message: String) { latestMessage = message; scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(message) } }
  LaunchedEffect(state.assistant.lastUpdatedAt) { queryPending = false }
  LaunchedEffect(state.serviceActivity.lastVideoStatusAt, state.serviceActivity.videoCaptureInProgress) { videoPending = false }
  LaunchedEffect(queryPending) { if (queryPending) { delay(3_000); queryPending = false; notify("提问尚未开始，请重试或查看诊断") } }
  LaunchedEffect(videoPending) { if (videoPending) { delay(3_000); videoPending = false; notify("视频录制尚未开始，请重试或查看诊断") } }
  fun startSensing() {
    val currentPermissions = permissionSnapshot(context)
    if (state.session == null || hostBlocked || !currentPermissions.canSense || state.runtimeStatus.phase in listOf(ServicePhase.RUNNING, ServicePhase.STARTING)) return
    explicitStart = true
    vm.updateRuntimeStatus(ServiceRuntimeStatus(phase = ServicePhase.STARTING))
    vm.setServiceEnabled(true)
    runCatching { SensorServiceController.start(context) }.onFailure {
      vm.setServiceEnabled(false)
      vm.updateRuntimeStatus(ServiceRuntimeStatus(phase = ServicePhase.ERROR, lastError = it.message))
      notify("无法开启感知，请查看诊断")
    }
  }
  fun stopSensing() {
    SensorServiceController.stop(context)
    vm.setServiceEnabled(false)
    vm.updateRuntimeStatus(ServiceRuntimeStatus(phase = ServicePhase.STOPPED))
    notify("感知已停止")
  }
  val sensorPermissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
    permissions = permissionSnapshot(context)
    if (pendingStart) {
      pendingStart = false
      if (permissions.canSense) startSensing() else notify("请允许通知，并至少授权相机或麦克风；也可到系统设置开启")
    }
  }
  val scannerPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    permissions = permissionSnapshot(context)
    if (granted) scannerTarget = pendingScanner else notify("扫码需要相机权限，也可以粘贴配对码")
    pendingScanner = ""
  }
  fun scanner(target: String) {
    if (state.runtimeStatus.phase == ServicePhase.RUNNING && state.runtimeStatus.mode in listOf(CaptureMode.FULL, CaptureMode.IMAGE_ONLY)) {
      notify("相机正在感知中。请粘贴配对码，或先停止感知再扫码。")
      return
    }
    if (permissions.camera) scannerTarget = target else { pendingScanner = target; scannerPermission.launch(Manifest.permission.CAMERA) }
  }
  fun requestStart() {
    if (state.session == null || hostBlocked) { nav.open(AppDestination.SENSOR_CONNECTION); return }
    if (permissionSnapshot(context).canSense) startSensing() else { pendingStart = true; sensorPermissions.launch(requiredSensorPermissions().toTypedArray()) }
  }
  // Owned by the app, never by a tab. An incoming digital share must not restore sensors.
  LaunchedEffect(state.session?.deviceId, state.serviceEnabled, entry.id) {
    if (!entry.digitalOnly && state.session != null && !hostBlocked && state.serviceEnabled && permissionSnapshot(context).canSense) {
      // Persisted RUNNING can outlive the process; START is idempotent in the service.
      runCatching { SensorServiceController.start(context) }.onFailure { notify("感知恢复失败，请查看诊断") }
    }
  }
  LaunchedEffect(state.runtimeStatus.phase) {
    if ((!entry.digitalOnly || explicitStart) && state.session != null && !hostBlocked && state.serviceEnabled && state.runtimeStatus.phase == ServicePhase.STOPPED && permissionSnapshot(context).canSense) startSensing()
  }
  LaunchedEffect(state.statusMessage) {
    state.statusMessage?.let { message ->
      latestMessage = message
      vm.setStatus(null)
      // Starting feedback is represented by the inline progress state.
      if (!state.isBusy) scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(message) }
    }
  }
  LaunchedEffect(entry.id, memory.loaded) {
    if (handledEntry != entry.id && memory.loaded) {
      handledEntry = entry.id
      if (entry.digitalOnly) {
        if (nav.destination == AppDestination.DRAFT && digital.dirty) {
          pendingShareId = entry.draftId
          afterLeave = "share"
          confirmLeave = true
        } else {
          nav.select(AppTab.MEMORY)
          entry.draftId?.let { id -> digital.selectDraft(id); nav.open(AppDestination.DRAFT, id) }
        }
        entry.message?.let(::notify)
      }
    }
  }
  fun leaveDetail() {
    digital.discardDraft()
    when (afterLeave) {
      "connect" -> { afterLeave = ""; nav.open(AppDestination.DIGITAL_CONNECTION) }
      "share" -> {
        afterLeave = ""; nav.select(AppTab.MEMORY)
        pendingShareId?.let { id -> digital.selectDraft(id); nav.open(AppDestination.DRAFT, id) }
        pendingShareId = null
      }
      else -> nav.back()
    }
  }
  fun back() {
    if (nav.destination == AppDestination.DRAFT && digital.dirty) { afterLeave = ""; confirmLeave = true } else nav.back()
  }
  BackHandler(enabled = nav.destination != AppDestination.HOME || nav.tab != AppTab.ASSISTANT) { if (!memory.busy) back() }
  LaunchedEffect(digital) {
    digital.events.collect { event -> when (event) {
      is DigitalEvent.Message -> notify(event.text)
      is DigitalEvent.OpenDraft -> { nav.select(AppTab.MEMORY); nav.open(AppDestination.DRAFT, event.id) }
      DigitalEvent.CloseDetail -> leaveDetail()
      DigitalEvent.Connected -> digitalCode = ""
    } }
  }
  LaunchedEffect(nav.destination, nav.itemId, memory.items) {
    if (nav.destination == AppDestination.DRAFT) digital.selectDraft(nav.itemId)
  }
  val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { digital.addImages(it) }
  val contacts = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    result.data?.data?.let { uri -> digital.addContact {
      withContext(Dispatchers.IO) {
        context.contentResolver.query(uri, arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.LOOKUP_KEY), null, null, null)?.use { cursor ->
          check(cursor.moveToFirst()) { "无法读取选中的联系人" }
          SelectedContact(cursor.getString(0) ?: "未命名联系人", cursor.getString(2) ?: uri.toString(), cursor.getString(1))
        } ?: error("无法读取选中的联系人")
      }
    } }
  }
  if (scannerTarget.isNotBlank()) QrScannerDialog(onDismiss = { scannerTarget = "" }, onDetected = { raw ->
    if (scannerTarget == "digital") digitalCode = raw else vm.onScannerResult(raw)
    scannerTarget = ""
  })
  if (confirmLeave) AlertDialog(onDismissRequest = { confirmLeave = false; afterLeave = "" }, title = { Text("保存本次修改？") }, text = { Text("可以先保存到本机，稍后再确认同步。") }, confirmButton = { TextButton(onClick = { confirmLeave = false; digital.saveDraft(close = true) }) { Text("保存并返回") } }, dismissButton = {
    Column { TextButton(onClick = { confirmLeave = false; leaveDetail() }) { Text("放弃修改") }; TextButton(onClick = { confirmLeave = false; afterLeave = "" }) { Text("继续编辑") } }
  })
  AppScaffold(nav, snackbar = snackbar, liveActive = liveState.connected || liveState.connecting, onOpenLive = { nav.open(AppDestination.LIVE) }, onStopLive = { SensorServiceController.stopLive(context) }, speaking = state.assistant.phase == AssistantInteractionPhase.SPEAKING_ANSWER, busy = memory.busy, onBack = ::back, onStopSpeaking = { SensorServiceController.stopAssistantSpeaking(context) }) { padding ->
    Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
      val key = if (nav.destination == AppDestination.HOME) nav.tab.name else "${nav.destination.name}/${nav.itemId}"
      stateHolder.SaveableStateProvider(key) {
        when (nav.destination) {
          AppDestination.HOME -> when (nav.tab) {
            AppTab.ASSISTANT -> AssistantScreen(displayState, permissions, hostBlocked, { nav.open(it) }, ::requestStart, { mode ->
              if (!queryPending && assistantGate(state, permissionSnapshot(context), hostBlocked) == AssistantGate.READY) { queryPending = true; SensorServiceController.triggerAssistantQuery(context, mode) }
            }, { SensorServiceController.stopAssistantSpeaking(context) }, { nav.select(AppTab.SENSING) })
            AppTab.MEMORY -> MemoryScreen(memory, { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, { contacts.launch(Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)) }, digital::createNote, digital::sync, { nav.open(AppDestination.DRAFT, it) }, { nav.open(AppDestination.MEMORY_DETAIL, it) }, { nav.open(AppDestination.DIGITAL_CONNECTION) }, digital::confirmMemory)
            AppTab.SENSING -> SensingScreen(displayState, permissions, warning, ::requestStart, ::stopSensing, { if (!videoPending && state.runtimeStatus.phase == ServicePhase.RUNNING && permissions.camera && !hostBlocked && !state.serviceActivity.videoCaptureInProgress) { videoPending = true; SensorServiceController.captureVideoClip(context) } }, { nav.open(it) })
            AppTab.SETTINGS -> SettingsScreen(state, memory.session) { nav.open(it) }
          }
          AppDestination.LIVE -> ai.openclaw.clawsense.live.LiveScreen()
          AppDestination.SENSOR_CONNECTION -> SensorConnectionScreen(state, warning, vm::onDeviceNameChanged, vm::onSetupCodeChanged, vm::onManualHostChanged, vm::onManualTokenChanged, { scanner("sensor") }, { vm.pairFromSetupCode(preserveServiceEnabled = state.session != null) }, { vm.pairManual(preserveServiceEnabled = state.session != null) }, { stopSensing(); vm.clearSession() })
          AppDestination.DIGITAL_CONNECTION -> DigitalConnectionScreen(memory.session, digitalCode, { digitalCode = it; digital.dismissError() }, memory.busy, memory.error, { scanner("digital") }, { digital.pair(digitalCode) })
          AppDestination.PERMISSIONS -> PermissionsScreen(permissions, { sensorPermissions.launch(arrayOf(it)) }, { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) })
          AppDestination.CAPTURE_PREFERENCES -> CapturePreferencesScreen(state, permissions, vm::setAutoVideoEnabled)
          AppDestination.DIAGNOSTICS -> DiagnosticsScreen(state, permissions, warning, latestMessage) { clipboard.setText(AnnotatedString(it)); notify("诊断信息已复制") }
          AppDestination.DRAFT -> DraftScreen(memory, digital) { if (digital.dirty) { afterLeave = "connect"; confirmLeave = true } else nav.open(AppDestination.DIGITAL_CONNECTION) }
          AppDestination.MEMORY_DETAIL -> MemoryDetailScreen(memory.records("events").find { it.string("eventId") == nav.itemId }, memory, digital)
        }
      }
    }
  }
}

@Composable internal fun AppScaffold(nav: AppNavigation, liveActive: Boolean = false, onOpenLive: () -> Unit = {}, onStopLive: () -> Unit = {}, snackbar: SnackbarHostState = remember { SnackbarHostState() }, speaking: Boolean = false, busy: Boolean = false, onBack: () -> Unit = { nav.back() }, onStopSpeaking: () -> Unit = {}, content: @Composable (PaddingValues) -> Unit) {
  val root = nav.destination == AppDestination.HOME
  Scaffold(
    topBar = { TopAppBar(title = { Text(if (root) nav.tab.label else nav.destination.title) }, navigationIcon = { if (!root) IconButton(onClick = onBack, enabled = !busy) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回") } }, actions = { if (root && nav.tab == AppTab.ASSISTANT) Text("ClawSense", Modifier.padding(end = 24.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }) },
    bottomBar = {
      Column {
        if (liveActive && nav.destination != AppDestination.LIVE) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
          Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = onOpenLive) { Text("Live 已开启 · 进入对话") }
            TextButton(onClick = onStopLive) { Text("结束 Live") }
          }
        }
        if (speaking && (nav.tab != AppTab.ASSISTANT || !root)) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
          Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("助手正在朗读", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onStopSpeaking) { Text("停止朗读") }
          }
        }
        if (!root) Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
        if (root) NavigationBar {
          AppTab.entries.forEach { tab -> NavigationBarItem(selected = nav.tab == tab, onClick = { nav.select(tab) }, icon = { Icon(when(tab) { AppTab.ASSISTANT -> Icons.Outlined.ChatBubbleOutline; AppTab.MEMORY -> Icons.Outlined.Bookmarks; AppTab.SENSING -> Icons.Outlined.Sensors; AppTab.SETTINGS -> Icons.Outlined.Settings }, contentDescription = null) }, label = { Text(tab.label) }, modifier = Modifier.testTag("tab_${tab.name.lowercase()}")) }
        }
      }
    },
    snackbarHost = { SnackbarHost(snackbar) },
    content = content,
  )
}
