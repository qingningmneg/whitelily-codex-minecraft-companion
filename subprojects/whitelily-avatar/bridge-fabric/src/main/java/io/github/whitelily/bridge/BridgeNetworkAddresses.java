package io.github.whitelily.bridge;

import java.net.InetSocketAddress;
import java.net.SocketAddress;

public final class BridgeNetworkAddresses {
  private BridgeNetworkAddresses() {}

  public static boolean isLoopback(SocketAddress address) {
    if (!(address instanceof InetSocketAddress inetAddress)) {
      return false;
    }
    return inetAddress.getAddress() != null && inetAddress.getAddress().isLoopbackAddress();
  }
}
