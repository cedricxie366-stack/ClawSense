package ai.openclaw.clawsense.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LightColors = lightColorScheme(
  primary = Color(0xFF006B60), onPrimary = Color.White,
  primaryContainer = Color(0xFFB5F1E4), onPrimaryContainer = Color(0xFF00201B),
  secondary = Color(0xFF4B635D), secondaryContainer = Color(0xFFD0E8DF),
  background = Color(0xFFF7FAF8), surface = Color(0xFFF7FAF8),
  surfaceContainer = Color(0xFFEBF0ED), surfaceContainerLow = Color(0xFFF0F5F2),
  onSurface = Color(0xFF17201D), onSurfaceVariant = Color(0xFF4D5C56),
  outlineVariant = Color(0xFFD3DDD7),
)
private val DarkColors = darkColorScheme(
  primary = Color(0xFF83D5C3), onPrimary = Color(0xFF00382F),
  primaryContainer = Color(0xFF005046), onPrimaryContainer = Color(0xFFA0EFDC),
  secondary = Color(0xFFB0CCC2), secondaryContainer = Color(0xFF344D44),
  background = Color(0xFF101613), surface = Color(0xFF101613),
  surfaceContainer = Color(0xFF1C2420), surfaceContainerLow = Color(0xFF171E1A),
  onSurface = Color(0xFFE0E9E2), onSurfaceVariant = Color(0xFFB9C9BF),
  outlineVariant = Color(0xFF3D4B43),
)

@Composable
internal fun ClawSenseTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
  val view = LocalView.current
  if (!view.isInEditMode) SideEffect {
    (view.context as? Activity)?.window?.let { window ->
      WindowCompat.getInsetsController(window, view).apply {
        isAppearanceLightStatusBars = !darkTheme
        isAppearanceLightNavigationBars = !darkTheme
      }
    }
  }
  MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors, typography = Typography(), content = content)
}
