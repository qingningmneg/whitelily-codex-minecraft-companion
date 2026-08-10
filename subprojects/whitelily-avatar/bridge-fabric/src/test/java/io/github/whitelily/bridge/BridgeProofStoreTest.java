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
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BridgeProofStoreTest {
  private static final String NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  private static final BridgeAuthorizationContext CONTEXT =
      new BridgeAuthorizationContext(true, true, 49152, 49152, "WhiteLily", 1500);

  @TempDir Path temporaryDirectory;

  @Test
  void consumesAnOrdinaryProofExactlyOnce() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    BridgeProofStore store = new BridgeProofStore(temporaryDirectory);

    assertEquals(Optional.of(new BridgeRequest(1, "WhiteLily", 49152, 1000, 2000, NONCE)), store.consume(NONCE, CONTEXT));
    assertFalse(Files.exists(request));
    assertFalse(Files.exists(request.resolveSibling(request.getFileName() + ".consumed")));
    assertEquals(Optional.empty(), store.consume(NONCE, CONTEXT));
  }

  @Test
  void concurrentConsumersAllowExactlyOneApproval() throws Exception {
    writeRequest(temporaryDirectory, validJson());
    ExecutorService executor = Executors.newFixedThreadPool(2);
    try {
      Callable<Boolean> consume = () -> new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT).isPresent();
      Future<Boolean> first = executor.submit(consume);
      Future<Boolean> second = executor.submit(consume);
      assertEquals(1, (first.get() ? 1 : 0) + (second.get() ? 1 : 0));
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void rejectsStrictJsonAndEncodingViolations() throws Exception {
    String[] invalidDocuments = {
      "{\"schemaVersion\":1,\"schemaVersion\":1,\"username\":\"WhiteLily\",\"port\":49152,\"issuedAt\":1000,\"expiresAt\":2000,\"nonce\":\"" + NONCE + "\"}",
      "{\"schemaVersion\":1,\"username\":\"WhiteLily\",\"port\":49152,\"issuedAt\":1000,\"expiresAt\":2000,\"nonce\":\"" + NONCE + "\",\"unknown\":true}",
      "[]",
      "",
    };
    for (String document : invalidDocuments) {
      Path root = Files.createTempDirectory(temporaryDirectory, "invalid-");
      writeRequest(root, document);
      assertEquals(Optional.empty(), new BridgeProofStore(root).consume(NONCE, CONTEXT));
    }

    Path bomRoot = Files.createTempDirectory(temporaryDirectory, "bom-");
    writeRequestBytes(bomRoot, concat(new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf}, validJson().getBytes(UTF_8)));
    assertEquals(Optional.empty(), new BridgeProofStore(bomRoot).consume(NONCE, CONTEXT));

    Path malformedRoot = Files.createTempDirectory(temporaryDirectory, "utf8-");
    writeRequestBytes(malformedRoot, new byte[] {(byte) 0xc3, (byte) 0x28});
    assertEquals(Optional.empty(), new BridgeProofStore(malformedRoot).consume(NONCE, CONTEXT));
  }

  @Test
  void rejectsOversizedAndMismatchedDigestRequests() throws Exception {
    Path oversized = Files.createTempDirectory(temporaryDirectory, "large-");
    writeRequest(oversized, " ".repeat(4097));
    assertEquals(Optional.empty(), new BridgeProofStore(oversized).consume(NONCE, CONTEXT));

    Path mismatched = Files.createTempDirectory(temporaryDirectory, "digest-");
    Files.writeString(mismatched.resolve("0".repeat(64) + ".json"), validJson(), UTF_8, StandardOpenOption.CREATE_NEW);
    assertEquals(Optional.empty(), new BridgeProofStore(mismatched).consume(NONCE, CONTEXT));
  }

  @Test
  void rejectsARequestWhoseBodyNonceDoesNotMatchItsDigestFilename() throws Exception {
    String otherNonce = "__________________________________________8";
    writeRequest(temporaryDirectory, validJson().replace(NONCE, otherNonce));
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
  }

  @Test
  void rejectsExpiredProofAndDoesNotConsumeIt() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson().replace("2000", "1500"));
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(request));
  }

  @Test
  void rejectsARequestSymlinkAndLinkedParent() throws Exception {
    Path sourceRoot = Files.createTempDirectory(temporaryDirectory, "source-");
    writeRequest(sourceRoot, validJson());
    Path linkRoot = Files.createTempDirectory(temporaryDirectory, "link-");
    Path requestLink = linkRoot.resolve(digest(NONCE) + ".json");
    createJunction(requestLink, sourceRoot);
    assertEquals(Optional.empty(), new BridgeProofStore(linkRoot).consume(NONCE, CONTEXT));
    Files.delete(requestLink);

    Path parentTarget = Files.createTempDirectory(temporaryDirectory, "parent-target-");
    writeRequest(parentTarget, validJson());
    Path parentLink = temporaryDirectory.resolve("parent-link");
    createJunction(parentLink, parentTarget);
    assertEquals(Optional.empty(), new BridgeProofStore(parentLink).consume(NONCE, CONTEXT));
    Files.delete(parentLink);
  }

  @Test
  void forcedNonAtomicMoveFailureDoesNotApproveOrDeleteRequest() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    BridgeProofStore store = new BridgeProofStore(temporaryDirectory, (source, consumed) -> { throw new java.nio.file.AtomicMoveNotSupportedException(source.toString(), consumed.toString(), "forced"); });
    assertEquals(Optional.empty(), store.consume(NONCE, CONTEXT));
    assertTrue(Files.exists(request));
  }

  @Test
  void windowsMoveNeverReplacesAnExistingConsumedSibling() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path consumed = request.resolveSibling(request.getFileName() + ".consumed");
    Files.writeString(consumed, "sentinel", UTF_8, StandardOpenOption.CREATE_NEW);
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertEquals("sentinel", Files.readString(consumed, UTF_8));
    assertTrue(Files.exists(request));
  }

  private static Path writeRequest(Path root, String document) throws Exception {
    return writeRequestBytes(root, document.getBytes(UTF_8));
  }

  private static Path writeRequestBytes(Path root, byte[] bytes) throws Exception {
    Path request = root.resolve(digest(NONCE) + ".json");
    Files.write(request, bytes, StandardOpenOption.CREATE_NEW);
    return request;
  }

  private static String validJson() {
    return "{\"schemaVersion\":1,\"username\":\"WhiteLily\",\"port\":49152,\"issuedAt\":1000,\"expiresAt\":2000,\"nonce\":\"" + NONCE + "\"}";
  }

  private static String digest(String value) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(UTF_8)));
  }

  private static byte[] concat(byte[] left, byte[] right) {
    byte[] result = new byte[left.length + right.length];
    System.arraycopy(left, 0, result, 0, left.length);
    System.arraycopy(right, 0, result, left.length, right.length);
    return result;
  }

  private static void createJunction(Path link, Path target) throws Exception {
    Process process = new ProcessBuilder("cmd.exe", "/c", "mklink", "/J", link.toString(), target.toString()).start();
    assertEquals(0, process.waitFor());
  }
}
