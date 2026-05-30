package ai.openclaw.clawsense.data

import android.util.Base64
import java.net.URI
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

object SetupCodeParser {
  private val json = Json { ignoreUnknownKeys = true }

  fun parse(raw: String): PairingSetup? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) {
      return null
    }

    parseJsonPayload(trimmed)?.let { return it }

    val normalized = trimmed.replace('-', '+').replace('_', '/')
    val padding = (4 - normalized.length % 4) % 4
    val padded = normalized + "=".repeat(padding)
    val decoded = runCatching {
      String(Base64.decode(padded, Base64.DEFAULT), Charsets.UTF_8)
    }.getOrNull() ?: return null

    return parseJsonPayload(decoded)
  }

  private fun parseJsonPayload(raw: String): PairingSetup? {
    val payload = runCatching { json.decodeFromString<SetupPayload>(raw) }.getOrNull() ?: return null
    val host = payload.url.trim().let(::normalizeHost)
    val token = payload.token.trim()
    if (host.isEmpty() || token.isEmpty()) {
      return null
    }
    return PairingSetup(
      host = host,
      token = token,
      warning = resolveHostWarning(host),
    )
  }

  private fun normalizeHost(host: String): String {
    val withProtocol = if (host.startsWith("http://") || host.startsWith("https://")) host else "http://$host"
    return withProtocol.trimEnd('/')
  }

  private fun resolveHostWarning(host: String): String? {
    val hostname = runCatching { URI(host).host?.trim()?.lowercase() }.getOrNull()
      ?: return null
    return when (hostname) {
      "lan" -> "二维码里的 Host 是 lan，手机无法解析。请在“手动兜底”里填写可访问的公网 IP/域名。"
      "0.0.0.0", "::", "::1", "127.0.0.1", "localhost" ->
        "二维码里的 Host 是本机回环/监听地址，外部手机无法访问。请改填服务器公网 IP/域名。"
      else -> null
    }
  }

  @Serializable
  private data class SetupPayload(
    @SerialName("url") val url: String,
    @SerialName("token") val token: String,
  )
}
