package ai.openclaw.clawsense.data

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import org.junit.Assert.*
import org.junit.Test

class AssistantFailureMessageTest {
  @Test fun missingDebugBridgeExplainsConnectionWithoutSocketDiagnostics() {
    val message = assistantFailureMessage(IOException("network", ConnectException("ECONNREFUSED :19490")), "http://127.0.0.1:19490")
    assertTrue(message.contains("调试连接")); assertTrue(message.contains("恢复连接"))
    assertFalse(message.contains("USB"))
    assertFalse(message.contains("ECONNREFUSED")); assertFalse(message.contains("19490"))
  }
  @Test fun lanFailureDoesNotSuggestUsb() {
    val message = assistantFailureMessage(ConnectException(), "http://192.168.1.12:18790")
    assertTrue(message.contains("网络")); assertFalse(message.contains("USB"))
  }
  @Test fun timeoutAndUnauthorizedHaveDifferentActions() {
    assertTrue(assistantFailureMessage(SocketTimeoutException(), "http://host").contains("超时"))
    assertTrue(assistantFailureMessage(ClawSenseAuthException("HTTP 401"), "http://host").contains("重新配对"))
  }
  @Test fun internalFailureIsNotShownAsAUserAnswer() {
    assertFalse(assistantFailureMessage(IOException("private internal details"), null).contains("private"))
  }
}
