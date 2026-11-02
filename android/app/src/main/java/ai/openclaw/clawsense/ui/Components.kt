package ai.openclaw.clawsense.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable internal fun PageColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
  Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp), content = content)
}
@Composable internal fun SectionTitle(title: String) {
  Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
}
@Composable internal fun SettingRow(title: String, detail: String, icon: ImageVector? = null, onClick: () -> Unit) {
  ListItem(
    headlineContent = { Text(title) }, supportingContent = { Text(detail) },
    leadingContent = icon?.let { { Icon(it, contentDescription = null, tint = MaterialTheme.colorScheme.primary) } },
    trailingContent = { Icon(Icons.Outlined.ChevronRight, contentDescription = null) },
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 64.dp),
    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
  )
}
@Composable internal fun Notice(title: String, detail: String? = null, action: String? = null, error: Boolean = false, onAction: () -> Unit = {}) {
  Surface(color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(title, style = MaterialTheme.typography.titleSmall, color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurface)
      if (!detail.isNullOrBlank()) Text(detail, style = MaterialTheme.typography.bodyMedium, color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant)
      if (action != null) TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 0.dp)) { Text(action) }
    }
  }
}
@Composable internal fun DetailRow(label: String, value: String) {
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(value, style = MaterialTheme.typography.bodyLarge)
  }
}
@Composable internal fun EmptyState(icon: ImageVector, title: String, detail: String, modifier: Modifier = Modifier) {
  Column(modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Icon(icon, contentDescription = null, modifier = Modifier.size(40.dp), tint = MaterialTheme.colorScheme.primary)
    Text(title, style = MaterialTheme.typography.titleLarge)
    Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
