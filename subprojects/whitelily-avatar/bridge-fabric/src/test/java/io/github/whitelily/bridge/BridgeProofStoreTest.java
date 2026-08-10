package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Assumptions;
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
    Path unrelated = temporaryDirectory.resolve("keep.txt");
    Files.writeString(unrelated, "keep", UTF_8, StandardOpenOption.CREATE_NEW);
    BridgeProofStore store = new BridgeProofStore(temporaryDirectory);

    assertEquals(Optional.of(new BridgeRequest(1, "WhiteLily", 49152, 1000, 2000, NONCE)), store.consume(NONCE, CONTEXT));
    assertFalse(Files.exists(request));
    assertFalse(Files.exists(request.resolveSibling(request.getFileName() + ".consumed")));
    assertEquals("keep", Files.readString(unrelated, UTF_8));
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
      Path request = writeRequest(root, document);
      assertEquals(Optional.empty(), new BridgeProofStore(root).consume(NONCE, CONTEXT));
      assertTrue(Files.exists(request));
    }

    Path bomRoot = Files.createTempDirectory(temporaryDirectory, "bom-");
    Path bom = writeRequestBytes(bomRoot, concat(new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf}, validJson().getBytes(UTF_8)));
    assertEquals(Optional.empty(), new BridgeProofStore(bomRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(bom));

    Path malformedRoot = Files.createTempDirectory(temporaryDirectory, "utf8-");
    Path malformed = writeRequestBytes(malformedRoot, new byte[] {(byte) 0xc3, (byte) 0x28});
    assertEquals(Optional.empty(), new BridgeProofStore(malformedRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(malformed));

    Path utf16LeRoot = Files.createTempDirectory(temporaryDirectory, "utf16le-");
    Path utf16Le = writeRequestBytes(utf16LeRoot, concat(new byte[] {(byte) 0xff, (byte) 0xfe}, validJson().getBytes(UTF_8)));
    assertEquals(Optional.empty(), new BridgeProofStore(utf16LeRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(utf16Le));

    Path utf16BeRoot = Files.createTempDirectory(temporaryDirectory, "utf16be-");
    Path utf16Be = writeRequestBytes(utf16BeRoot, concat(new byte[] {(byte) 0xfe, (byte) 0xff}, validJson().getBytes(UTF_8)));
    assertEquals(Optional.empty(), new BridgeProofStore(utf16BeRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(utf16Be));
  }

  @Test
  void rejectsMissingAndCaseVariantKeysWithoutConsumingTheRequest() throws Exception {
    Path missingRoot = Files.createTempDirectory(temporaryDirectory, "missing-");
    Path missing = writeRequest(missingRoot, validJson().replace(",\"port\":49152", ""));
    assertEquals(Optional.empty(), new BridgeProofStore(missingRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(missing));

    Path caseRoot = Files.createTempDirectory(temporaryDirectory, "case-");
    Path caseVariant = writeRequest(caseRoot, validJson().replace("\"username\"", "\"Username\""));
    assertEquals(Optional.empty(), new BridgeProofStore(caseRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(caseVariant));
  }

  @Test
  void acceptsAnExactly4096ByteDocument() throws Exception {
    String document = validJson();
    writeRequest(temporaryDirectory, document + " ".repeat(4096 - document.getBytes(UTF_8).length));
    assertTrue(new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT).isPresent());
  }

  @Test
  void failsClosedWhenTheFilesystemDoesNotExposeABasicFileIdentity() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    BasicFileAttributes first = Files.readAttributes(request, BasicFileAttributes.class);
    BasicFileAttributes second = Files.readAttributes(request, BasicFileAttributes.class);
    Assumptions.assumeTrue(first.fileKey() == null && second.fileKey() == null);
    assertFalse(BridgeProofStore.sameFile(first, second));
  }

  @Test
  void rejectsOversizedAndMismatchedDigestRequests() throws Exception {
    Path oversized = Files.createTempDirectory(temporaryDirectory, "large-");
    Path oversizedRequest = writeRequest(oversized, " ".repeat(4097));
    assertEquals(Optional.empty(), new BridgeProofStore(oversized).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(oversizedRequest));

    Path mismatched = Files.createTempDirectory(temporaryDirectory, "digest-");
    Files.writeString(mismatched.resolve("0".repeat(64) + ".json"), validJson(), UTF_8, StandardOpenOption.CREATE_NEW);
    assertEquals(Optional.empty(), new BridgeProofStore(mismatched).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(mismatched.resolve("0".repeat(64) + ".json")));
  }

  @Test
  void rejectsARequestWhoseBodyNonceDoesNotMatchItsDigestFilename() throws Exception {
    String otherNonce = "__________________________________________8";
    Path request = writeRequest(temporaryDirectory, validJson().replace(NONCE, otherNonce));
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(request));
  }

  @Test
  void rejectsExpiredProofAndDoesNotConsumeIt() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson().replace("2000", "1500"));
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(request));
  }

  @Test
  void rejectsFutureAndInvertedProofTimesWithoutConsumingTheRequest() throws Exception {
    Path futureRoot = Files.createTempDirectory(temporaryDirectory, "future-");
    Path future = writeRequest(futureRoot, validJson().replace("\"issuedAt\":1000", "\"issuedAt\":1501"));
    assertEquals(Optional.empty(), new BridgeProofStore(futureRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(future));

    Path invertedRoot = Files.createTempDirectory(temporaryDirectory, "inverted-");
    Path inverted = writeRequest(invertedRoot, validJson().replace("\"expiresAt\":2000", "\"expiresAt\":1000"));
    assertEquals(Optional.empty(), new BridgeProofStore(invertedRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(inverted));
  }

  @Test
  void rejectsARequestDirectoryJunctionAndLinkedParent() throws Exception {
    Path sourceRoot = Files.createTempDirectory(temporaryDirectory, "source-");
    writeRequest(sourceRoot, validJson());
    Path linkRoot = Files.createTempDirectory(temporaryDirectory, "link-");
    Path requestLink = linkRoot.resolve(digest(NONCE) + ".json");
    createJunction(requestLink, sourceRoot);
    assertEquals(Optional.empty(), new BridgeProofStore(linkRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(requestLink, java.nio.file.LinkOption.NOFOLLOW_LINKS));
    Files.delete(requestLink);

    Path parentTarget = Files.createTempDirectory(temporaryDirectory, "parent-target-");
    writeRequest(parentTarget, validJson());
    Path parentLink = temporaryDirectory.resolve("parent-link");
    createJunction(parentLink, parentTarget);
    assertEquals(Optional.empty(), new BridgeProofStore(parentLink).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(parentLink, java.nio.file.LinkOption.NOFOLLOW_LINKS));
    Files.delete(parentLink);
  }

  @Test
  void rejectsAFileSymlinkRequestWhenTheWindowsConfigurationPermitsIt() throws Exception {
    Path sourceRoot = Files.createTempDirectory(temporaryDirectory, "file-source-");
    Path source = writeRequest(sourceRoot, validJson());
    Path linkRoot = Files.createTempDirectory(temporaryDirectory, "file-link-");
    Path requestLink = linkRoot.resolve(source.getFileName());
    try {
      Files.createSymbolicLink(requestLink, source);
    } catch (FileSystemException | UnsupportedOperationException unsupported) {
      Assumptions.abort("Windows symbolic-link privilege is unavailable: " + unsupported.getMessage());
    }
    assertEquals(Optional.empty(), new BridgeProofStore(linkRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(requestLink, java.nio.file.LinkOption.NOFOLLOW_LINKS));
    Files.delete(requestLink);
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
