package ai.openclaw.clawsense.data

import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException

/** Keep transport failures actionable without reading socket diagnostics aloud. */
fun assistantFailureMessage(error: Throwable, host: String?): String {
  val causes = generateSequence(error) { current -> current.cause?.takeUnless { it === current } }.take(8).toList()
  if (causes.any { it is ClawSenseAuthException }) return "设备凭证已失效，请重新配对后再试。"
  if (causes.any { it is UnknownHostException }) return "暂时找不到电脑主机，请检查配对地址和网络后重试。"
  if (causes.any { it is SocketTimeoutException }) return "等待电脑回复超时，请检查连接后重试。"
  if (causes.any { it is ConnectException || it is SocketException }) {
    val name = runCatching { URI(host.orEmpty()).host }.getOrNull()
    return if (name in listOf("127.0.0.1", "localhost", "::1", "[::1]"))
      "手机暂时连不上电脑。调试连接可能已中断，请恢复连接后重试。"
    else "手机暂时连不上电脑，请检查手机与电脑的网络和主机状态后重试。"
  }
  return "助手暂时无法完成回答，请稍后重试。"
}
