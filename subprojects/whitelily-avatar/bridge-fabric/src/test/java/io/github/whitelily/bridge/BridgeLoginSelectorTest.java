package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BridgeLoginSelectorTest {
  private static final String NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  private static final String BRIDGE_HOST = "127.0.0.1\0WL1\0" + NONCE;

  @TempDir Path temporaryDirectory;

  @Test
  void ordinaryHostnameSelectsVanillaWithoutConsumingARequest() throws Exception {
    Path request = writeValidRequest(temporaryDirectory, 1_000, 31_000);
    HandshakeProofSlot connection = new HandshakeProofSlot();

    assertFalse(BridgeLoginSelector.captureHandshake("127.0.0.1", 49_152, true, connection));
    assertEquals(
        BridgeLoginDecision.VANILLA,
        selector().select(connection, true, true, 49_152, 49_152, "WhiteLily", 1_500));
    assertTrue(Files.exists(request));
  }

  @Test
  void remoteSocketSelectsVanillaWithoutRetainingTheCandidate() throws Exception {
    Path request = writeValidRequest(temporaryDirectory, 1_000, 31_000);
    HandshakeProofSlot connection = new HandshakeProofSlot();

    assertFalse(BridgeLoginSelector.captureHandshake(BRIDGE_HOST, 49_152, false, connection));
    assertEquals(
        BridgeLoginDecision.VANILLA,
        selector().select(connection, true, false, 49_152, 49_152, "WhiteLily", 1_500));
    assertTrue(Files.exists(request));
    assertTrue(connection.whitelily$takeHandshakeProof().isEmpty());
  }

  @Test
  void wrongUsernameSelectsVanilla() throws Exception {
    writeValidRequest(temporaryDirectory, 1_000, 31_000);
    assertRejected(true, true, 49_152, 49_152, "whiteLily", 1_500);
  }

  @Test
  void dedicatedServerSelectsVanilla() throws Exception {
    writeValidRequest(temporaryDirectory, 1_000, 31_000);
    assertRejected(false, true, 49_152, 49_152, "WhiteLily", 1_500);
  }

  @Test
  void wrongCurrentPublishedPortSelectsVanilla() throws Exception {
    writeValidRequest(temporaryDirectory, 1_000, 31_000);
    assertRejected(true, true, 49_152, 49_153, "WhiteLily", 1_500);
  }

  @Test
  void wrongCurrentLocalPortSelectsVanilla() throws Exception {
    writeValidRequest(temporaryDirectory, 1_000, 31_000);
    assertRejected(true, true, 49_153, 49_152, "WhiteLily", 1_500);
  }

  @Test
  void expiredProofSelectsVanilla() throws Exception {
    writeValidRequest(temporaryDirectory, 1_000, 31_000);
    assertRejected(true, true, 49_152, 49_152, "WhiteLily", 31_000);
  }

  @Test
  void completeLocalIntegratedRowSelectsTheBridgeProfileExactlyOnce() throws Exception {
    Path request = writeValidRequest(temporaryDirectory, 1_000, 31_000);
    HandshakeProofSlot connection = new HandshakeProofSlot();

    assertTrue(BridgeLoginSelector.captureHandshake(BRIDGE_HOST, 49_152, true, connection));
    assertFalse(connection.toString().contains(NONCE));
    assertEquals(
        BridgeLoginDecision.BRIDGE_OFFLINE_PROFILE,
        selector().select(connection, true, true, 49_152, 49_152, "WhiteLily", 1_500));
    assertEquals(
        BridgeLoginDecision.VANILLA,
        selector().select(connection, true, true, 49_152, 49_152, "WhiteLily", 1_500));
    assertFalse(Files.exists(request));
    assertTrue(connection.whitelily$takeHandshakeProof().isEmpty());
  }

  @Test
  void candidateStateNeverRendersTheNonceAndAtomicallyTakesItOnce() {
    HandshakeProofSlot connection = new HandshakeProofSlot();
    connection.whitelily$setHandshakeProof(NONCE, 49_152);

    String rendered = String.valueOf(connection.whitelily$takeHandshakeProof());

    assertFalse(rendered.contains(NONCE));
    assertTrue(connection.whitelily$takeHandshakeProof().isEmpty());
  }

  @Test
  void nonCanonicalBase64UrlNonceIsNeverRetainedAsACandidate() {
    HandshakeProofSlot connection = new HandshakeProofSlot();
    String nonCanonical = NONCE.substring(0, NONCE.length() - 1) + "B";

    assertFalse(BridgeLoginSelector.captureHandshake("127.0.0.1\0WL1\0" + nonCanonical, 49_152, true, connection));
    assertTrue(connection.whitelily$takeHandshakeProof().isEmpty());
  }

  @Test
  void nonWindowsHostNeverRetainsABridgeCandidateEvenWhenLocalAppDataIsConfigured() {
    String previousOs = System.getProperty("os.name");
    String previousLocalAppData = System.getProperty("LOCALAPPDATA");
    try {
      System.setProperty("os.name", "Linux");
      System.setProperty("LOCALAPPDATA", temporaryDirectory.toString());
      HandshakeProofSlot connection = new HandshakeProofSlot();

      assertFalse(BridgeLoginSelector.captureHandshake(BRIDGE_HOST, 49_152, true, connection));
      assertTrue(connection.whitelily$takeHandshakeProof().isEmpty());
    } finally {
      restoreProperty("os.name", previousOs);
      restoreProperty("LOCALAPPDATA", previousLocalAppData);
    }
  }

  private void assertRejected(
      boolean integratedServer,
      boolean loopbackRemote,
      int localPort,
      int publishedPort,
      String username,
      long now) {
    HandshakeProofSlot connection = new HandshakeProofSlot();
    assertTrue(BridgeLoginSelector.captureHandshake(BRIDGE_HOST, 49_152, true, connection));
    assertEquals(
        BridgeLoginDecision.VANILLA,
        selector().select(
            connection,
            integratedServer,
            loopbackRemote,
            localPort,
            publishedPort,
            username,
            now));
    assertTrue(connection.whitelily$takeHandshakeProof().isEmpty());
  }

  private BridgeLoginSelector selector() {
    return new BridgeLoginSelector(new BridgeProofStore(temporaryDirectory));
  }

  private static Path writeValidRequest(Path root, long issuedAt, long expiresAt) throws Exception {
    String json =
        "{\"schemaVersion\":1,\"username\":\"WhiteLily\",\"port\":49152,"
            + "\"issuedAt\":"
            + issuedAt
            + ",\"expiresAt\":"
            + expiresAt
            + ",\"nonce\":\""
            + NONCE
            + "\"}";
    Path request = root.resolve(digest(NONCE) + ".json");
    Files.writeString(request, json, UTF_8, StandardOpenOption.CREATE_NEW);
    return request;
  }

  private static String digest(String value) throws Exception {
    return HexFormat.of()
        .formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(UTF_8)));
  }

  private static void restoreProperty(String name, String value) {
    if (value == null) {
      System.clearProperty(name);
    } else {
      System.setProperty(name, value);
    }
  }
}
