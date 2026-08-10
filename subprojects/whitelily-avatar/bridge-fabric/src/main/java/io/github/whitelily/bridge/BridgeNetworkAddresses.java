package io.github.whitelily.bridge;

import java.net.InetSocketAddress;
import java.net.SocketAddress;

final class BridgeNetworkAddresses {
  private BridgeNetworkAddresses() {}

  static boolean isLoopback(SocketAddress address) {
    if (!(address instanceof InetSocketAddress inetAddress)) {
      return false;
    }
    return inetAddress.getAddress() != null && inetAddress.getAddress().isLoopbackAddress();
  }
}
