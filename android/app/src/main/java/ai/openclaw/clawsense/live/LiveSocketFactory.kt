package ai.openclaw.clawsense.live

import java.net.InetAddress
import java.net.Socket
import javax.net.SocketFactory

/** Live sends small PCM packets; do not hold them for TCP acknowledgement batching. */
internal class LiveSocketFactory(
  private val delegate: SocketFactory = SocketFactory.getDefault(),
) : SocketFactory() {
  @Volatile var defaultNoDelay: Boolean? = null; private set
  @Volatile var configuredNoDelay: Boolean? = null; private set

  private fun configure(socket: Socket): Socket {
    try {
      defaultNoDelay = socket.tcpNoDelay
      socket.tcpNoDelay = true
      configuredNoDelay = socket.tcpNoDelay
      return socket
    } catch (error: Exception) {
      runCatching { socket.close() }
      throw error
    }
  }
  override fun createSocket(): Socket = configure(delegate.createSocket())
  override fun createSocket(host: String, port: Int): Socket = configure(delegate.createSocket(host, port))
  override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket =
    configure(delegate.createSocket(host, port, local, localPort))
  override fun createSocket(host: InetAddress, port: Int): Socket = configure(delegate.createSocket(host, port))
  override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket =
    configure(delegate.createSocket(host, port, local, localPort))
}
