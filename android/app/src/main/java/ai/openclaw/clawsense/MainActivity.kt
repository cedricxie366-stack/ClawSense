@file:OptIn(ExperimentalLayoutApi::class)

package ai.openclaw.clawsense

import ai.openclaw.clawsense.data.CaptureMode
import ai.openclaw.clawsense.data.DeviceSession
import ai.openclaw.clawsense.data.ServicePhase
import ai.openclaw.clawsense.data.ServiceRuntimeStatus
import ai.openclaw.clawsense.service.SensorServiceController
import ai.openclaw.clawsense.ui.QrScannerDialog
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PlayCircleOutline
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.SettingsInputAntenna
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent {
      val viewModel = viewModel<MainViewModel>(
        factory = MainViewModelFactory(AppGraph.repository(this)),
      )
      ClawSenseScreen(viewModel)
    }
  }
}

private object ClawSensePalette {
  val BackgroundTop = Color(0xFF06111C)
  val BackgroundMid = Color(0xFF0F2740)
  val BackgroundBottom = Color(0xFF111922)
  val Card = Color(0xCC0F1D2D)
  val CardStrong = Color(0xE0132940)
  val CardMuted = Color(0xCC172434)
  val TextPrimary = Color(0xFFF4F7FB)
  val TextSecondary = Color(0xFFB2C3D4)
  val Accent = Color(0xFF81D4FA)
  val AccentStrong = Color(0xFF00C8B3)
  val Warning = Color(0xFFFFC857)
  val Danger = Color(0xFFFF6B6B)
  val Stroke = Color(0x332A8BB8)
}

data class PermissionSnapshot(
  val camera: Boolean,
  val microphone: Boolean,
  val notifications: Boolean,
)

data class RuntimeVisual(
  val title: String,
  val detail: String,
  val color: Color,
  val chipLabel: String,
  val icon: ImageVector,
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ClawSenseScreen(viewModel: MainViewModel) {
  val context = LocalContext.current
  val uiState by viewModel.uiState.collectAsStateWithLifecycle()
  val session = uiState.session
  var scannerOpen by rememberSaveable { mutableStateOf(false) }
  val permissions = permissionSnapshot(context)

  val sensorPermissionsLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.RequestMultiplePermissions(),
  ) {
    val refreshed = permissionSnapshot(context)
    if (refreshed.notifications && (refreshed.camera || refreshed.microphone)) {
      SensorServiceController.start(context)
      viewModel.setServiceEnabled(true)
      viewModel.setStatus(buildStartMessage(refreshed))
    } else {
      viewModel.setStatus("启动失败：至少授予相机或麦克风中的一个，并允许通知。")
    }
  }

  val scannerPermissionLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.RequestPermission(),
  ) { granted ->
    if (granted) {
      scannerOpen = true
    } else {
      viewModel.setStatus("扫码需要相机权限。")
    }
  }

  LaunchedEffect(uiState.session?.deviceId, uiState.serviceEnabled) {
    if (uiState.session != null && uiState.serviceEnabled && canStartSensing(context)) {
      SensorServiceController.start(context)
    }
  }

  if (scannerOpen) {
    QrScannerDialog(
      onDismiss = { scannerOpen = false },
      onDetected = { raw ->
        scannerOpen = false
        viewModel.onScannerResult(raw)
      },
    )
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("ClawSense", color = ClawSensePalette.TextPrimary) },
        modifier = Modifier.statusBarsPadding(),
      )
    },
  ) { padding ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .background(
          Brush.verticalGradient(
            listOf(
              ClawSensePalette.BackgroundTop,
              ClawSensePalette.BackgroundMid,
              ClawSensePalette.BackgroundBottom,
            ),
          ),
        )
        .verticalScroll(rememberScrollState())
        .padding(padding)
        .padding(horizontal = 16.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      HeroCard(uiState.session != null, uiState.runtimeStatus, permissions)
      ServiceRuntimeCard(
        uiState = uiState,
        permissions = permissions,
        onStart = {
          if (canStartSensing(context)) {
            SensorServiceController.start(context)
            viewModel.setServiceEnabled(true)
            viewModel.setStatus(buildStartMessage(permissions))
          } else {
            sensorPermissionsLauncher.launch(requiredSensorPermissions().toTypedArray())
          }
        },
        onStop = {
          SensorServiceController.stop(context)
          viewModel.setServiceEnabled(false)
          viewModel.updateRuntimeStatus(
            ServiceRuntimeStatus(
              phase = ServicePhase.STOPPED,
              mode = CaptureMode.NONE,
            ),
          )
          viewModel.setStatus("感知服务已停止，音频、拍照和心跳都已暂停。")
        },
      )
      PermissionCard(permissions)
      EventCard(uiState.statusMessage, uiState.isBusy)

      if (session == null) {
        PairingCard(
          uiState = uiState,
          onSetupCodeChanged = viewModel::onSetupCodeChanged,
          onManualHostChanged = viewModel::onManualHostChanged,
          onManualTokenChanged = viewModel::onManualTokenChanged,
          onDeviceNameChanged = viewModel::onDeviceNameChanged,
          onOpenScanner = {
            if (permissions.camera) {
              scannerOpen = true
            } else {
              scannerPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
          },
          onPairFromCode = viewModel::pairFromSetupCode,
          onPairManual = viewModel::pairManual,
        )
      } else {
        SessionSummaryCard(
          session = session,
          serviceEnabled = uiState.serviceEnabled,
          runtimeStatus = uiState.runtimeStatus,
          onClearPairing = {
            SensorServiceController.stop(context)
            viewModel.clearSession()
          },
        )
      }
    }
  }
}

@Composable
private fun HeroCard(
  isPaired: Boolean,
  runtimeStatus: ServiceRuntimeStatus,
  permissions: PermissionSnapshot,
) {
  val visual = runtimeVisual(runtimeStatus, isPaired)
  Card(
    colors = CardDefaults.cardColors(containerColor = ClawSensePalette.CardStrong),
    shape = RoundedCornerShape(30.dp),
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(22.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
      ) {
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(
            text = if (isPaired) "旧手机已经接入 ClawSense。" else "先配对，再启动全天候感知。",
            style = MaterialTheme.typography.headlineSmall,
            color = ClawSensePalette.TextPrimary,
            fontWeight = FontWeight.SemiBold,
          )
          Text(
            text = "这个页面现在会明确告诉你：是否已配对、服务是否运行、当前是全功能还是降级模式，以及最近一次状态变化时间。",
            style = MaterialTheme.typography.bodyMedium,
            color = ClawSensePalette.TextSecondary,
          )
        }
        StatusPill(label = visual.chipLabel, color = visual.color)
      }

      FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        OutlineTag(
          icon = Icons.Outlined.Memory,
          text = if (isPaired) "已配对" else "未配对",
        )
        OutlineTag(
          icon = Icons.Outlined.GraphicEq,
          text = if (permissions.microphone) "麦克风已授权" else "麦克风未授权",
        )
        OutlineTag(
          icon = Icons.Outlined.CameraAlt,
          text = if (permissions.camera) "相机已授权" else "相机未授权",
        )
        OutlineTag(
          icon = Icons.Outlined.Notifications,
          text = if (permissions.notifications) "通知已授权" else "通知未授权",
        )
      }
    }
  }
}

@Composable
private fun ServiceRuntimeCard(
  uiState: MainUiState,
  permissions: PermissionSnapshot,
  onStart: () -> Unit,
  onStop: () -> Unit,
) {
  val visual = runtimeVisual(uiState.runtimeStatus, uiState.session != null)
  val updatedAtText = formatTimestamp(uiState.runtimeStatus.updatedAt)

  Card(
    colors = CardDefaults.cardColors(containerColor = ClawSensePalette.Card),
    shape = RoundedCornerShape(28.dp),
  ) {
    Column(
      modifier = Modifier.padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Text("服务状态", style = MaterialTheme.typography.titleLarge, color = ClawSensePalette.TextPrimary)

      Surface(
        color = visual.color.copy(alpha = 0.14f),
        shape = RoundedCornerShape(24.dp),
      ) {
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .padding(18.dp),
          horizontalArrangement = Arrangement.spacedBy(14.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Box(
            modifier = Modifier
              .size(48.dp)
              .background(visual.color.copy(alpha = 0.18f), CircleShape),
            contentAlignment = Alignment.Center,
          ) {
            Icon(visual.icon, contentDescription = null, tint = visual.color)
          }
          Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
              text = visual.title,
              style = MaterialTheme.typography.titleLarge,
              color = ClawSensePalette.TextPrimary,
              fontWeight = FontWeight.SemiBold,
            )
            Text(
              text = visual.detail,
              style = MaterialTheme.typography.bodyMedium,
              color = ClawSensePalette.TextSecondary,
            )
            Text(
              text = "最近变更：$updatedAtText",
              style = MaterialTheme.typography.labelMedium,
              color = visual.color,
            )
          }
        }
      }

      FlowRow(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        PermissionChip(
          ok = permissions.camera,
          icon = Icons.Outlined.PhotoCamera,
          label = if (permissions.camera) "拍照可用" else "拍照不可用",
        )
        PermissionChip(
          ok = permissions.microphone,
          icon = Icons.Outlined.GraphicEq,
          label = if (permissions.microphone) "音频可用" else "音频不可用",
        )
        PermissionChip(
          ok = permissions.notifications,
          icon = Icons.Outlined.Notifications,
          label = if (permissions.notifications) "通知可用" else "通知不可用",
        )
      }

      Text(
        text = when {
          uiState.session == null -> "先完成配对，下面的启动按钮才会真正工作。"
          uiState.runtimeStatus.phase == ServicePhase.RUNNING &&
            uiState.runtimeStatus.mode == CaptureMode.FULL -> "当前是完整模式：音频 VAD、定格拍照、心跳都在运行。"
          uiState.runtimeStatus.phase == ServicePhase.RUNNING &&
            uiState.runtimeStatus.mode == CaptureMode.AUDIO_ONLY -> "当前是仅音频模式：相机未参与，适合先验证录音上传。"
          uiState.runtimeStatus.phase == ServicePhase.RUNNING &&
            uiState.runtimeStatus.mode == CaptureMode.IMAGE_ONLY -> "当前是仅图片模式：麦克风未参与，适合先验证定格拍照上传。"
          uiState.runtimeStatus.phase == ServicePhase.STARTING -> "服务正在从 UI 切到前台通知模式，通常 1 到 2 秒内会进入运行中。"
          else -> "停止后，前台通知会消失，音频采集、定格拍照和心跳都会暂停。"
        },
        style = MaterialTheme.typography.bodyMedium,
        color = ClawSensePalette.TextSecondary,
      )

      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Button(
          onClick = onStart,
          modifier = Modifier.weight(1f),
          enabled = uiState.session != null && !uiState.isBusy,
          colors = ButtonDefaults.buttonColors(containerColor = ClawSensePalette.AccentStrong),
        ) {
          Icon(Icons.Outlined.PlayCircleOutline, contentDescription = null)
          Spacer(Modifier.width(8.dp))
          Text("启动感知服务")
        }
        FilledTonalButton(
          onClick = onStop,
          modifier = Modifier.weight(1f),
          enabled = uiState.session != null,
        ) {
          Icon(Icons.Outlined.StopCircle, contentDescription = null)
          Spacer(Modifier.width(8.dp))
          Text("停止服务")
        }
      }
    }
  }
}

@Composable
private fun PermissionCard(permissions: PermissionSnapshot) {
  Card(
    colors = CardDefaults.cardColors(containerColor = ClawSensePalette.CardMuted),
    shape = RoundedCornerShape(26.dp),
  ) {
    Column(
      modifier = Modifier.padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text("权限检查", style = MaterialTheme.typography.titleMedium, color = ClawSensePalette.TextPrimary)
      PermissionRow(
        icon = Icons.Outlined.CameraAlt,
        title = "相机",
        status = if (permissions.camera) "已授权" else "未授权",
        ok = permissions.camera,
        detail = "影响定格拍照上传。",
      )
      PermissionRow(
        icon = Icons.Outlined.GraphicEq,
        title = "麦克风",
        status = if (permissions.microphone) "已授权" else "未授权",
        ok = permissions.microphone,
        detail = "影响 VAD 音频采集与上传。",
      )
      PermissionRow(
        icon = Icons.Outlined.Notifications,
        title = "通知",
        status = if (permissions.notifications) "已授权" else "未授权",
        ok = permissions.notifications,
        detail = "影响前台服务能否稳定运行。",
      )
    }
  }
}

@Composable
private fun EventCard(message: String?, isBusy: Boolean) {
  if (message.isNullOrBlank() && !isBusy) {
    return
  }
  Card(
    colors = CardDefaults.cardColors(containerColor = Color(0xCC17202B)),
    shape = RoundedCornerShape(26.dp),
  ) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .padding(18.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      if (isBusy) {
        CircularProgressIndicator(
          modifier = Modifier.size(20.dp),
          strokeWidth = 2.dp,
          color = ClawSensePalette.Accent,
        )
      } else {
        Icon(Icons.Outlined.SettingsInputAntenna, contentDescription = null, tint = ClawSensePalette.Accent)
      }
      Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text("最近事件", style = MaterialTheme.typography.titleSmall, color = ClawSensePalette.TextPrimary)
        Text(message ?: "处理中…", style = MaterialTheme.typography.bodyMedium, color = ClawSensePalette.TextSecondary)
      }
    }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PairingCard(
  uiState: MainUiState,
  onSetupCodeChanged: (String) -> Unit,
  onManualHostChanged: (String) -> Unit,
  onManualTokenChanged: (String) -> Unit,
  onDeviceNameChanged: (String) -> Unit,
  onOpenScanner: () -> Unit,
  onPairFromCode: () -> Unit,
  onPairManual: () -> Unit,
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = ClawSensePalette.Card),
    shape = RoundedCornerShape(28.dp),
  ) {
    Column(
      modifier = Modifier.padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Text("首次配对", style = MaterialTheme.typography.titleLarge, color = ClawSensePalette.TextPrimary)
      Text(
        "推荐直接扫服务器终端二维码。只有当云端二维码里的 Host 不对，才需要走下面的手动 Host + Token 兜底。",
        style = MaterialTheme.typography.bodyMedium,
        color = ClawSensePalette.TextSecondary,
      )

      OutlinedTextField(
        value = uiState.deviceName,
        onValueChange = onDeviceNameChanged,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("设备名称") },
        singleLine = true,
      )
      OutlinedTextField(
        value = uiState.setupCode,
        onValueChange = onSetupCodeChanged,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("二维码内容 / 引导码") },
        placeholder = { Text("扫码后这里会自动填入") },
        minLines = 3,
      )

      FlowRow(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Button(onClick = onOpenScanner) {
          Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
          Spacer(Modifier.width(8.dp))
          Text("扫码")
        }
        FilledTonalButton(onClick = onPairFromCode) {
          Icon(Icons.Outlined.Link, contentDescription = null)
          Spacer(Modifier.width(8.dp))
          Text("用引导码配对")
        }
      }

      Text("手动兜底", style = MaterialTheme.typography.titleMedium, color = ClawSensePalette.TextPrimary)
      OutlinedTextField(
        value = uiState.manualHost,
        onValueChange = onManualHostChanged,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Host") },
        placeholder = { Text("http://你的服务器IP:18789") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        singleLine = true,
      )
      OutlinedTextField(
        value = uiState.manualToken,
        onValueChange = onManualTokenChanged,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Setup Token") },
        singleLine = true,
      )
      FilledTonalButton(onClick = onPairManual, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Outlined.Lock, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text("手动配对")
      }
    }
  }
}

@Composable
private fun SessionSummaryCard(
  session: DeviceSession,
  serviceEnabled: Boolean,
  runtimeStatus: ServiceRuntimeStatus,
  onClearPairing: () -> Unit,
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = ClawSensePalette.Card),
    shape = RoundedCornerShape(28.dp),
  ) {
    Column(
      modifier = Modifier.padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      Text("设备信息", style = MaterialTheme.typography.titleLarge, color = ClawSensePalette.TextPrimary)
      MetricRow(Icons.Outlined.PhoneAndroid, "设备 ID", session.deviceId)
      MetricRow(Icons.Outlined.Link, "Host", session.host)
      MetricRow(Icons.Outlined.SettingsInputAntenna, "上传基址", session.uploadBaseUrl)
      MetricRow(Icons.Outlined.Memory, "记忆命名空间", session.memoryNamespace)
      MetricRow(Icons.Outlined.Notifications, "心跳间隔", "${session.heartbeatIntervalSec} 秒")
      MetricRow(
        Icons.Outlined.CheckCircle,
        "自动恢复标记",
        if (serviceEnabled) "已开启" else "已关闭",
      )
      MetricRow(
        Icons.Outlined.RadioButtonUnchecked,
        "当前模式",
        captureModeLabel(runtimeStatus.mode),
      )

      FilledTonalButton(onClick = onClearPairing, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Outlined.WarningAmber, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text("清除配对")
      }
    }
  }
}

@Composable
private fun PermissionRow(
  icon: ImageVector,
  title: String,
  status: String,
  ok: Boolean,
  detail: String,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier = Modifier
        .size(40.dp)
        .background((if (ok) ClawSensePalette.AccentStrong else ClawSensePalette.Warning).copy(alpha = 0.16f), CircleShape),
      contentAlignment = Alignment.Center,
    ) {
      Icon(icon, contentDescription = null, tint = if (ok) ClawSensePalette.AccentStrong else ClawSensePalette.Warning)
    }
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text("$title · $status", color = ClawSensePalette.TextPrimary, style = MaterialTheme.typography.titleSmall)
      Text(detail, color = ClawSensePalette.TextSecondary, style = MaterialTheme.typography.bodySmall)
    }
  }
}

@Composable
private fun MetricRow(icon: ImageVector, label: String, value: String) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Icon(icon, contentDescription = null, tint = ClawSensePalette.Accent, modifier = Modifier.padding(top = 2.dp))
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(label, color = ClawSensePalette.Accent, style = MaterialTheme.typography.labelLarge)
      Text(value, color = ClawSensePalette.TextPrimary, style = MaterialTheme.typography.bodyLarge)
    }
  }
}

@Composable
private fun PermissionChip(ok: Boolean, icon: ImageVector, label: String) {
  Surface(
    color = if (ok) ClawSensePalette.AccentStrong.copy(alpha = 0.12f) else ClawSensePalette.Warning.copy(alpha = 0.14f),
    shape = RoundedCornerShape(18.dp),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(icon, contentDescription = null, tint = if (ok) ClawSensePalette.AccentStrong else ClawSensePalette.Warning, modifier = Modifier.size(16.dp))
      Text(label, color = ClawSensePalette.TextPrimary, style = MaterialTheme.typography.labelLarge)
    }
  }
}

@Composable
private fun OutlineTag(icon: ImageVector, text: String) {
  Surface(
    color = Color.Transparent,
    shape = RoundedCornerShape(18.dp),
    tonalElevation = 0.dp,
    border = androidx.compose.foundation.BorderStroke(1.dp, ClawSensePalette.Stroke),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(icon, contentDescription = null, tint = ClawSensePalette.Accent, modifier = Modifier.size(16.dp))
      Text(text, color = ClawSensePalette.TextPrimary, style = MaterialTheme.typography.labelLarge)
    }
  }
}

@Composable
private fun StatusPill(label: String, color: Color) {
  Surface(
    color = color.copy(alpha = 0.18f),
    shape = RoundedCornerShape(999.dp),
  ) {
    Text(
      text = label,
      color = color,
      style = MaterialTheme.typography.labelLarge,
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
    )
  }
}

private fun buildStartMessage(permissions: PermissionSnapshot): String {
  return when {
    permissions.camera && permissions.microphone -> "启动命令已发出，正在切到前台通知模式。"
    permissions.microphone -> "启动命令已发出，预计会进入仅音频模式。"
    permissions.camera -> "启动命令已发出，预计会进入仅图片模式。"
    else -> "启动命令已发出。"
  }
}

private fun permissionSnapshot(context: android.content.Context): PermissionSnapshot {
  return PermissionSnapshot(
    camera = hasPermission(context, Manifest.permission.CAMERA),
    microphone = hasPermission(context, Manifest.permission.RECORD_AUDIO),
    notifications = hasPermission(context, Manifest.permission.POST_NOTIFICATIONS),
  )
}

private fun runtimeVisual(status: ServiceRuntimeStatus, hasSession: Boolean): RuntimeVisual {
  if (!hasSession) {
    return RuntimeVisual(
      title = "尚未配对",
      detail = "先扫服务器二维码，成功换取永久 deviceSecret 后，下面的服务状态才会进入运行流程。",
      color = ClawSensePalette.Warning,
      chipLabel = "未配对",
      icon = Icons.Outlined.Link,
    )
  }

  return when (status.phase) {
    ServicePhase.STARTING -> RuntimeVisual(
      title = "正在启动",
      detail = "已经接收到启动命令，前台通知和传感器循环正在准备中。",
      color = ClawSensePalette.Accent,
      chipLabel = "启动中",
      icon = Icons.Outlined.PlayCircleOutline,
    )
    ServicePhase.RUNNING -> RuntimeVisual(
      title = when (status.mode) {
        CaptureMode.FULL -> "运行中 · 完整模式"
        CaptureMode.AUDIO_ONLY -> "运行中 · 仅音频"
        CaptureMode.IMAGE_ONLY -> "运行中 · 仅图片"
        CaptureMode.NONE -> "运行中 · 等待权限"
      },
      detail = when (status.mode) {
        CaptureMode.FULL -> "音频 VAD、定格拍照和心跳都在运行。"
        CaptureMode.AUDIO_ONLY -> "音频 VAD 与心跳在运行，相机链路当前未参与。"
        CaptureMode.IMAGE_ONLY -> "定格拍照与心跳在运行，音频链路当前未参与。"
        CaptureMode.NONE -> "服务已启动，但当前没有可用采集权限。"
      },
      color = ClawSensePalette.AccentStrong,
      chipLabel = "运行中",
      icon = Icons.Outlined.CheckCircle,
    )
    ServicePhase.ERROR -> RuntimeVisual(
      title = "运行异常",
      detail = status.lastError ?: "服务启动过，但遇到了异常。请查看最近事件。",
      color = ClawSensePalette.Danger,
      chipLabel = "异常",
      icon = Icons.Outlined.WarningAmber,
    )
    ServicePhase.STOPPED -> RuntimeVisual(
      title = "已停止",
      detail = "前台通知、音频采集、定格拍照和后台心跳都已停止。",
      color = ClawSensePalette.Warning,
      chipLabel = "已停止",
      icon = Icons.Outlined.StopCircle,
    )
  }
}

private fun captureModeLabel(mode: CaptureMode): String {
  return when (mode) {
    CaptureMode.FULL -> "音频 + 图片"
    CaptureMode.AUDIO_ONLY -> "仅音频"
    CaptureMode.IMAGE_ONLY -> "仅图片"
    CaptureMode.NONE -> "未运行"
  }
}

private fun formatTimestamp(timestamp: Long): String {
  return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(timestamp))
}

private fun requiredSensorPermissions(): List<String> {
  return buildList {
    add(Manifest.permission.CAMERA)
    add(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      add(Manifest.permission.POST_NOTIFICATIONS)
    }
  }
}

private fun hasAnyCapturePermission(context: android.content.Context): Boolean {
  return hasPermission(context, Manifest.permission.CAMERA) ||
    hasPermission(context, Manifest.permission.RECORD_AUDIO)
}

private fun canStartSensing(context: android.content.Context): Boolean {
  return hasPermission(context, Manifest.permission.POST_NOTIFICATIONS) &&
    hasAnyCapturePermission(context)
}

private fun hasPermission(context: android.content.Context, permission: String): Boolean {
  if (permission == Manifest.permission.POST_NOTIFICATIONS && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
    return true
  }
  return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

private class MainViewModelFactory(
  private val repository: ai.openclaw.clawsense.data.DeviceSessionRepository,
) : androidx.lifecycle.ViewModelProvider.Factory {
  override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T {
    if (modelClass.isAssignableFrom(MainViewModel::class.java)) {
      @Suppress("UNCHECKED_CAST")
      return MainViewModel(repository) as T
    }
    error("Unsupported ViewModel: ${modelClass.name}")
  }
}
