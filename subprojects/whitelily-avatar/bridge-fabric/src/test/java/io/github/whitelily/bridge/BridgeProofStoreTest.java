package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.lang.reflect.Field;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;
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

    assertEquals(Optional.of(new BridgeRequest(1, "WhiteLily", 49152, 1000, 31000, NONCE)), store.consume(NONCE, CONTEXT));
    assertFalse(Files.exists(request));
    assertFalse(Files.exists(request.resolveSibling(request.getFileName() + ".claim")));
    assertFalse(Files.exists(request.resolveSibling(request.getFileName() + ".anchor")));
    assertEquals("keep", Files.readString(unrelated, UTF_8));
    assertEquals(Optional.empty(), store.consume(NONCE, CONTEXT));
  }

  @Test
  void rejectsAPreexistingRetainedHardLinkWithoutConsumingTheProof() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path retained = temporaryDirectory.resolve("retained-proof.json");
    Files.createLink(retained, request);

    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(request));
    assertTrue(Files.exists(retained));
    assertEquals(validJson(), Files.readString(retained, UTF_8));
  }

  @Test
  void rejectsANonCanonicalBase64UrlNonceBeforeOpeningItsProof() throws Exception {
    String nonCanonical = NONCE.substring(0, NONCE.length() - 1) + "B";
    Path request = temporaryDirectory.resolve(digest(nonCanonical) + ".json");
    Files.writeString(request, validJson().replace(NONCE, nonCanonical), UTF_8, StandardOpenOption.CREATE_NEW);

    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(nonCanonical, CONTEXT));
    assertTrue(Files.exists(request));
  }

  @Test
  void rejectsASameSizeThreePathReplacementWithoutDeletingIt() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path claim = request.resolveSibling(request.getFileName() + ".claim");
    Path anchor = request.resolveSibling(request.getFileName() + ".anchor");
    Path replacement = temporaryDirectory.resolve("same-size-replacement.json");
    String foreignDocument = validJson().replace("\"issuedAt\":1000", "\"issuedAt\":1001");
    assertEquals(validJson().getBytes(UTF_8).length, foreignDocument.getBytes(UTF_8).length);
    Files.writeString(replacement, foreignDocument, UTF_8, StandardOpenOption.CREATE_NEW);
    Field hook = BridgeProofStore.class.getDeclaredField("beforeClaimHook");
    hook.setAccessible(true);
    hook.set(
        null,
        (Runnable)
            () -> {
              try {
                Files.delete(request);
                Files.delete(claim);
                Files.delete(anchor);
                Files.createLink(request, replacement);
                Files.createLink(claim, replacement);
                Files.createLink(anchor, replacement);
              } catch (java.io.IOException failure) {
                throw new RuntimeException(failure);
              }
            });
    try {
      assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
      assertEquals(foreignDocument, Files.readString(request, UTF_8));
      assertEquals(foreignDocument, Files.readString(claim, UTF_8));
      assertEquals(foreignDocument, Files.readString(anchor, UTF_8));
      assertEquals(foreignDocument, Files.readString(replacement, UTF_8));
    } finally {
      hook.set(null, null);
    }
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
    Path request = writeRequest(temporaryDirectory, validJson().replace("31000", "1500"));
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
    Path inverted = writeRequest(invertedRoot, validJson().replace("\"expiresAt\":31000", "\"expiresAt\":1000"));
    assertEquals(Optional.empty(), new BridgeProofStore(invertedRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(inverted));
  }

  @Test
  void rejectsNonCanonicalNumericLexemesWithoutConsumingTheRequest() throws Exception {
    String[] invalid = {
      validJson().replace("\"schemaVersion\":1", "\"schemaVersion\":1.0"),
      validJson().replace("\"port\":49152", "\"port\":4.9152e4"),
      validJson().replace("\"issuedAt\":1000", "\"issuedAt\":\"1000\""),
      validJson().replace("\"expiresAt\":31000", "\"expiresAt\":null"),
      validJson().replace("\"issuedAt\":1000", "\"issuedAt\":9223372036854775808"),
    };
    for (String document : invalid) {
      Path root = Files.createTempDirectory(temporaryDirectory, "numeric-");
      Path request = writeRequest(root, document);
      assertEquals(Optional.empty(), new BridgeProofStore(root).consume(NONCE, CONTEXT));
      assertTrue(Files.exists(request));
    }
  }

  @Test
  void rejectsNonThirtySecondTtlWithoutConsumingTheRequest() throws Exception {
    String[] invalid = {
      validJson().replace("\"expiresAt\":31000", "\"expiresAt\":31001"),
      validJson().replace("\"issuedAt\":1000", "\"issuedAt\":-1"),
      validJson().replace("\"issuedAt\":1000", "\"issuedAt\":9223372036854770000").replace("\"expiresAt\":31000", "\"expiresAt\":-9223372036854740000"),
    };
    for (String document : invalid) {
      Path root = Files.createTempDirectory(temporaryDirectory, "ttl-");
      Path request = writeRequest(root, document);
      assertEquals(Optional.empty(), new BridgeProofStore(root).consume(NONCE, CONTEXT));
      assertTrue(Files.exists(request));
    }
  }

  @Test
  void claimCollisionBlocksConsumptionAndPreservesClaimAndRequest() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path claim = request.resolveSibling(request.getFileName() + ".claim");
    Files.writeString(claim, "collision", UTF_8, StandardOpenOption.CREATE_NEW);
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertEquals("collision", Files.readString(claim, UTF_8));
    assertTrue(Files.exists(request));
  }

  @Test
  void crashStatesAfterClaimAfterAnchorAndAfterRequestRemovalBlockReuse() throws Exception {
    Path afterClaimRoot = Files.createTempDirectory(temporaryDirectory, "after-claim-");
    Path afterClaimRequest = writeRequest(afterClaimRoot, validJson());
    Path afterClaim = afterClaimRequest.resolveSibling(afterClaimRequest.getFileName() + ".claim");
    Files.createLink(afterClaim, afterClaimRequest);
    assertEquals(Optional.empty(), new BridgeProofStore(afterClaimRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(afterClaimRequest));
    assertTrue(Files.exists(afterClaim));

    Path afterAnchorRoot = Files.createTempDirectory(temporaryDirectory, "after-anchor-");
    Path afterAnchorRequest = writeRequest(afterAnchorRoot, validJson());
    Path afterAnchorClaim = afterAnchorRequest.resolveSibling(afterAnchorRequest.getFileName() + ".claim");
    Path afterAnchor = afterAnchorRequest.resolveSibling(afterAnchorRequest.getFileName() + ".anchor");
    Files.createLink(afterAnchorClaim, afterAnchorRequest);
    Files.createLink(afterAnchor, afterAnchorClaim);
    assertEquals(Optional.empty(), new BridgeProofStore(afterAnchorRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(afterAnchorRequest));
    assertTrue(Files.exists(afterAnchorClaim));
    assertTrue(Files.exists(afterAnchor));

    Path afterRemovalRoot = Files.createTempDirectory(temporaryDirectory, "after-removal-");
    Path afterRemovalRequest = writeRequest(afterRemovalRoot, validJson());
    Path afterRemovalClaim = afterRemovalRequest.resolveSibling(afterRemovalRequest.getFileName() + ".claim");
    Path afterRemovalAnchor = afterRemovalRequest.resolveSibling(afterRemovalRequest.getFileName() + ".anchor");
    Files.createLink(afterRemovalClaim, afterRemovalRequest);
    Files.createLink(afterRemovalAnchor, afterRemovalClaim);
    Files.delete(afterRemovalRequest);
    assertEquals(Optional.empty(), new BridgeProofStore(afterRemovalRoot).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(afterRemovalClaim));
    assertTrue(Files.exists(afterRemovalAnchor));
  }

  @Test
  void anchorCollisionBlocksConsumptionAndPreservesTheForeignAnchor() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path anchor = request.resolveSibling(request.getFileName() + ".anchor");
    Files.writeString(anchor, "foreign-anchor", UTF_8, StandardOpenOption.CREATE_NEW);
    assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
    assertEquals("foreign-anchor", Files.readString(anchor, UTF_8));
    assertTrue(Files.exists(request));
    assertFalse(Files.exists(request.resolveSibling(request.getFileName() + ".claim")));
  }

  @Test
  void existingConsumedSiblingIsNeverOverwrittenOrDeleted() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path consumed = request.resolveSibling(request.getFileName() + ".consumed");
    Files.writeString(consumed, "foreign-consumed", UTF_8, StandardOpenOption.CREATE_NEW);
    assertTrue(new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT).isPresent());
    assertEquals("foreign-consumed", Files.readString(consumed, UTF_8));
    assertTrue(Files.exists(consumed));
  }

  @Test
  void replacementBetweenParsingAndClaimFailsClosedAndSurvives() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path replacement = temporaryDirectory.resolve("replacement.json");
    String replacementDocument = validJson().replace("\"issuedAt\":1000", "\"issuedAt\":1001").replace("\"expiresAt\":31000", "\"expiresAt\":31001");
    Files.writeString(replacement, replacementDocument, UTF_8, StandardOpenOption.CREATE_NEW);
    Field hook = BridgeProofStore.class.getDeclaredField("beforeClaimHook");
    hook.setAccessible(true);
    hook.set(null, (Runnable) () -> {
      try {
        Files.move(replacement, request, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      } catch (java.io.IOException failure) {
        throw new RuntimeException(failure);
      }
    });
    try {
      assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
      assertEquals(replacementDocument, Files.readString(request, UTF_8));
    } finally {
      hook.set(null, null);
    }
  }

  @Test
  void successCleanupPreservesAnAnchorReplacementAtItsBoundary() throws Exception {
    Path request = writeRequest(temporaryDirectory, validJson());
    Path anchor = request.resolveSibling(request.getFileName() + ".anchor");
    Path foreign = temporaryDirectory.resolve("foreign-anchor");
    Files.writeString(foreign, "foreign-anchor-content", UTF_8, StandardOpenOption.CREATE_NEW);
    AtomicInteger hookCalls = new AtomicInteger();
    Field hook = BridgeProofStore.class.getDeclaredField("beforeSuccessCleanupHook");
    hook.setAccessible(true);
    hook.set(null, (Runnable) () -> {
      try {
        hookCalls.incrementAndGet();
        Files.delete(anchor);
        Files.move(foreign, anchor, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
      } catch (java.io.IOException failure) {
        throw new RuntimeException(failure);
      }
    });
    try {
      assertEquals(Optional.empty(), new BridgeProofStore(temporaryDirectory).consume(NONCE, CONTEXT));
      assertEquals(1, hookCalls.get());
      assertEquals("foreign-anchor-content", Files.readString(anchor, UTF_8));
      assertTrue(Files.exists(request.resolveSibling(request.getFileName() + ".claim")));
    } finally {
      hook.set(null, null);
    }
  }

  @Test
  void rejectsAReparsePointInTheConfiguredRootAncestorChain() throws Exception {
    Path target = Files.createTempDirectory(temporaryDirectory, "ancestor-target-");
    Path ancestor = temporaryDirectory.resolve("ancestor-link");
    createJunction(ancestor, target);
    Path root = ancestor.resolve("nested-proof-root");
    Files.createDirectory(root);
    Path request = writeRequest(root, validJson());
    assertEquals(Optional.empty(), new BridgeProofStore(root).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(request));
    Files.delete(ancestor);
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
  void rejectsAFileSymlinkRequestWhenWindowsPermitsIt() throws Exception {
    Path sourceRoot = Files.createTempDirectory(temporaryDirectory, "symlink-source-");
    Path source = writeRequest(sourceRoot, validJson());
    Path root = Files.createTempDirectory(temporaryDirectory, "symlink-root-");
    Path link = root.resolve(source.getFileName());
    try {
      Files.createSymbolicLink(link, source);
    } catch (FileSystemException | UnsupportedOperationException unavailable) {
      Assumptions.abort("symbolic-link privilege unavailable");
    }
    assertEquals(Optional.empty(), new BridgeProofStore(root).consume(NONCE, CONTEXT));
    assertTrue(Files.exists(link, java.nio.file.LinkOption.NOFOLLOW_LINKS));
  }

  @Test
  void failedJunctionHelperCleansOnlyTheCreatedLink() throws Exception {
    Path target = Files.createTempDirectory(temporaryDirectory, "junction-target-");
    Path sentinel = target.resolve("sentinel.txt");
    Files.writeString(sentinel, "target-survives", UTF_8, StandardOpenOption.CREATE_NEW);
    Path link = temporaryDirectory.resolve("failed-junction-link");
    assertThrows(AssertionError.class, () -> createJunction(link, target, () -> new ProcessBuilder(
        "cmd.exe", "/c", "mklink", "/J", link.toString(), target.toString(), "&", "exit", "/b", "1").start()));
    assertFalse(Files.exists(link, java.nio.file.LinkOption.NOFOLLOW_LINKS));
    assertEquals("target-survives", Files.readString(sentinel, UTF_8));
  }

  @Test
  void failedJunctionCleanupDoesNotExposeTheLiteralLinkPath() throws Exception {
    Path target = Files.createTempDirectory(temporaryDirectory, "cleanup-target-");
    Path link = temporaryDirectory.resolve("cleanup-link");
    AssertionError failure = assertThrows(AssertionError.class, () -> createJunction(link, target,
        () -> new ProcessBuilder("cmd.exe", "/c", "mklink", "/J", link.toString(), target.toString(), "&", "exit", "/b", "1").start(),
        ignored -> { throw new java.nio.file.FileSystemException(link.toString()); }));
    assertFalse(failure.getMessage().contains(link.toString()));
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
    return "{\"schemaVersion\":1,\"username\":\"WhiteLily\",\"port\":49152,\"issuedAt\":1000,\"expiresAt\":31000,\"nonce\":\"" + NONCE + "\"}";
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
    createJunction(link, target, () -> new ProcessBuilder(
        "cmd.exe", "/c", "mklink", "/J", link.toString(), target.toString()).start());
  }

  private static void createJunction(Path link, Path target, JunctionCommand command) throws Exception {
    createJunction(link, target, command, BridgeProofStoreTest::deleteLinkNoFollow);
  }

  private static void createJunction(Path link, Path target, JunctionCommand command, JunctionLinkCleanup cleanup) throws Exception {
    Process process = null;
    boolean succeeded = false;
    try {
      process = command.start();
      if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
        process.destroyForcibly();
        assertTrue(process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS), "junction helper child did not terminate");
        throw new AssertionError("junction helper timed out");
      }
      assertEquals(0, process.exitValue());
      succeeded = true;
    } finally {
      if (!succeeded) {
        if (process != null && process.isAlive()) {
          process.destroyForcibly();
          assertTrue(process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS), "junction helper child did not terminate");
        }
        try {
          cleanup.delete(link);
        } catch (java.io.IOException cleanupFailure) {
          throw new AssertionError("junction helper cleanup failed");
        }
      }
    }
  }

  @FunctionalInterface
  private interface JunctionCommand {
    Process start() throws java.io.IOException;
  }

  @FunctionalInterface
  private interface JunctionLinkCleanup {
    void delete(Path link) throws java.io.IOException;
  }

  private static void deleteLinkNoFollow(Path link) throws java.io.IOException {
    if (Files.exists(link, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
      Files.delete(link);
    }
  }
}
