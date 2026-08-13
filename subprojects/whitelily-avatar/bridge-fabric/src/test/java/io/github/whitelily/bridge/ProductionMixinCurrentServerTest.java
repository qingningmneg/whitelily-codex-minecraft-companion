package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mojang.authlib.GameProfile;
import io.github.whitelily.bridge.mixin.PlayerListMixin;
import io.github.whitelily.bridge.mixin.ServerLoginPacketListenerImplMixin;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.login.ServerboundHelloPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import sun.misc.Unsafe;

@SuppressWarnings({"deprecation", "removal"})
class ProductionMixinCurrentServerTest {
  private static final Unsafe UNSAFE = unsafe();
  private static final String NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  private static final int PORT = 49_152;

  private final java.util.List<IntegratedServer> servers = new java.util.ArrayList<>();
  private Object previousMinecraftInstance;
  private Minecraft minecraft;
  private Path request;

  @BeforeEach
  void prepareProductionRuntimeRootAndMinecraftSingleton() throws Exception {
    Path localAppData = Path.of(System.getenv("LOCALAPPDATA"));
    Path requests = localAppData.resolve("WhiteLily").resolve("bridge").resolve("requests");
    Files.createDirectories(requests);
    request = requests.resolve(digest(NONCE) + ".json");
    Files.deleteIfExists(request.resolveSibling(request.getFileName() + ".claim"));
    Files.deleteIfExists(request.resolveSibling(request.getFileName() + ".anchor"));
    Files.deleteIfExists(request);

    minecraft = allocate(Minecraft.class);
    Field instance = Minecraft.class.getDeclaredField("instance");
    previousMinecraftInstance = getStatic(instance);
    setStatic(instance, minecraft);
  }

  @AfterEach
  void restoreProcessState() throws Exception {
    for (IntegratedServer server : servers) {
      ApprovedProfileRegistry.clearServer(server);
    }
    Field instance = Minecraft.class.getDeclaredField("instance");
    setStatic(instance, previousMinecraftInstance);
    Files.deleteIfExists(request.resolveSibling(request.getFileName() + ".claim"));
    Files.deleteIfExists(request.resolveSibling(request.getFileName() + ".anchor"));
    Files.deleteIfExists(request);
  }

  @Test
  void loginCallbackRejectsAnOldPublishedServerWhenCurrentIsNullWithoutConsumingProof()
      throws Exception {
    IntegratedServer oldServer = publishedServer();
    setCurrentServer(null);
    writeValidRequest();
    TestConnection connection = connectionWithProof();
    LoginMixinHarness mixin = loginMixin(oldServer, connection);

    CallbackInfo callback = invokeLogin(mixin);

    assertFalse(callback.isCancelled());
    assertNull(mixin.verifiedProfile);
    assertTrue(Files.exists(request));
    assertTrue(connection.whitelily$takeHandshakeProof().isPresent());
  }

  @Test
  void loginCallbackRejectsAnOldPublishedServerWhenAnotherServerIsCurrentWithoutConsumingProof()
      throws Exception {
    IntegratedServer oldServer = publishedServer();
    setCurrentServer(publishedServer());
    writeValidRequest();
    TestConnection connection = connectionWithProof();
    LoginMixinHarness mixin = loginMixin(oldServer, connection);

    CallbackInfo callback = invokeLogin(mixin);

    assertFalse(callback.isCancelled());
    assertNull(mixin.verifiedProfile);
    assertTrue(Files.exists(request));
    assertTrue(connection.whitelily$takeHandshakeProof().isPresent());
  }

  @Test
  void loginCallbackAuthorizesTheExactCurrentPublishedServer() throws Exception {
    IntegratedServer currentServer = publishedServer();
    setCurrentServer(currentServer);
    writeValidRequest();
    TestConnection connection = connectionWithProof();
    LoginMixinHarness mixin = loginMixin(currentServer, connection);

    CallbackInfo callback = invokeLogin(mixin);

    assertTrue(callback.isCancelled());
    assertEquals(WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID, mixin.verifiedProfile.getId());
    assertEquals(WhiteLilyBridge.WHITE_LILY_USERNAME, mixin.verifiedProfile.getName());
    assertFalse(Files.exists(request));
    assertTrue(
        connection.whitelily$takePendingApproval(
            currentServer, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID));
  }

  @Test
  void loginCallbackFailsClosedWhenTheCurrentServerChangesDuringProofConsumption()
      throws Exception {
    IntegratedServer currentServer = publishedServer();
    setCurrentServer(currentServer);
    writeValidRequest();
    TestConnection connection = connectionWithProof();
    LoginMixinHarness mixin = loginMixin(currentServer, connection);
    Field hook = BridgeProofStore.class.getDeclaredField("beforeSuccessCleanupHook");
    hook.setAccessible(true);
    hook.set(
        null,
        (Runnable)
            () -> {
              try {
                setCurrentServer(null);
              } catch (Exception failure) {
                throw new RuntimeException(failure);
              }
            });
    try {
      CallbackInfo callback = invokeLogin(mixin);

      assertFalse(callback.isCancelled());
      assertNull(mixin.verifiedProfile);
      assertFalse(Files.exists(request));
      assertFalse(
          connection.whitelily$takePendingApproval(
              currentServer, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID));
    } finally {
      hook.set(null, null);
    }
  }

  @Test
  void placementCallbackRejectsAnOldPublishedServerWhenCurrentIsNull() throws Exception {
    IntegratedServer oldServer = publishedServer();
    setCurrentServer(null);
    TestConnection connection = connectionWithPendingApproval(oldServer);

    invokePlacement(playerListMixin(oldServer), connection, whiteLilyPlayer());

    assertNotApproved(oldServer);
    assertTrue(
        connection.whitelily$takePendingApproval(
            oldServer, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID));
  }

  @Test
  void placementCallbackRejectsAnOldPublishedServerWhenAnotherServerIsCurrent() throws Exception {
    IntegratedServer oldServer = publishedServer();
    setCurrentServer(publishedServer());
    TestConnection connection = connectionWithPendingApproval(oldServer);

    invokePlacement(playerListMixin(oldServer), connection, whiteLilyPlayer());

    assertNotApproved(oldServer);
    assertTrue(
        connection.whitelily$takePendingApproval(
            oldServer, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID));
  }

  @Test
  void placementCallbackApprovesTheExactCurrentPublishedServer() throws Exception {
    IntegratedServer currentServer = publishedServer();
    setCurrentServer(currentServer);
    TestConnection connection = connectionWithPendingApproval(currentServer);

    invokePlacement(playerListMixin(currentServer), connection, whiteLilyPlayer());

    assertTrue(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            currentServer,
            WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID,
            WhiteLilyBridge.WHITE_LILY_USERNAME));
    assertFalse(
        connection.whitelily$takePendingApproval(
            currentServer, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID));
  }

  private void writeValidRequest() throws Exception {
    long issuedAt = System.currentTimeMillis() - 1_000;
    String document =
        "{\"schemaVersion\":1,\"username\":\"WhiteLily\",\"port\":"
            + PORT
            + ",\"issuedAt\":"
            + issuedAt
            + ",\"expiresAt\":"
            + (issuedAt + 30_000)
            + ",\"nonce\":\""
            + NONCE
            + "\"}";
    Files.writeString(request, document, UTF_8, StandardOpenOption.CREATE_NEW);
  }

  private IntegratedServer publishedServer() throws Exception {
    IntegratedServer server = allocate(IntegratedServer.class);
    setInt(server, IntegratedServer.class.getDeclaredField("publishedPort"), PORT);
    servers.add(server);
    return server;
  }

  private void setCurrentServer(IntegratedServer server) throws Exception {
    setObject(
        minecraft,
        Minecraft.class.getDeclaredField("singleplayerServer"),
        server);
  }

  private static LoginMixinHarness loginMixin(
      IntegratedServer server, TestConnection connection) {
    LoginMixinHarness mixin = new LoginMixinHarness();
    mixin.prepare(server, connection);
    return mixin;
  }

  private static CallbackInfo invokeLogin(LoginMixinHarness mixin) throws Exception {
    CallbackInfo callback = new CallbackInfo("handleHello", true);
    Method method =
        ServerLoginPacketListenerImplMixin.class.getDeclaredMethod(
            "whitelily$authorizeBridgeProfile", ServerboundHelloPacket.class, CallbackInfo.class);
    method.setAccessible(true);
    method.invoke(
        mixin,
        new ServerboundHelloPacket(
            WhiteLilyBridge.WHITE_LILY_USERNAME, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID),
        callback);
    return callback;
  }

  private static PlayerListMixinHarness playerListMixin(IntegratedServer server) throws Exception {
    PlayerListMixinHarness mixin = new PlayerListMixinHarness();
    setObject(mixin, PlayerListMixin.class.getDeclaredField("server"), server);
    return mixin;
  }

  private static void invokePlacement(
      PlayerListMixinHarness mixin, TestConnection connection, ServerPlayer player)
      throws Exception {
    Method method =
        PlayerListMixin.class.getDeclaredMethod(
            "whitelily$completeApprovedProfile",
            Connection.class,
            ServerPlayer.class,
            net.minecraft.server.network.CommonListenerCookie.class,
            CallbackInfo.class);
    method.setAccessible(true);
    method.invoke(mixin, connection, player, null, new CallbackInfo("placeNewPlayer", false));
  }

  private static ServerPlayer whiteLilyPlayer() throws Exception {
    net.minecraft.SharedConstants.tryDetectVersion();
    net.minecraft.server.Bootstrap.bootStrap();
    ServerPlayer player = allocate(ServerPlayer.class);
    GameProfile profile =
        new GameProfile(
            WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID, WhiteLilyBridge.WHITE_LILY_USERNAME);
    setObject(player, Player.class.getDeclaredField("gameProfile"), profile);
    setObject(player, Entity.class.getDeclaredField("uuid"), profile.getId());
    return player;
  }

  private static TestConnection connectionWithProof() {
    TestConnection connection = new TestConnection();
    connection.whitelily$setHandshakeProof(NONCE, PORT);
    return connection;
  }

  private static TestConnection connectionWithPendingApproval(IntegratedServer server) {
    TestConnection connection = new TestConnection();
    connection.whitelily$markPendingApproval(server, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID);
    return connection;
  }

  private static void assertNotApproved(IntegratedServer server) {
    assertFalse(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            server,
            WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID,
            WhiteLilyBridge.WHITE_LILY_USERNAME));
  }

  private static String digest(String value) throws Exception {
    return HexFormat.of()
        .formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(UTF_8)));
  }

  private static Unsafe unsafe() {
    try {
      Field field = Unsafe.class.getDeclaredField("theUnsafe");
      field.setAccessible(true);
      return (Unsafe) field.get(null);
    } catch (ReflectiveOperationException failure) {
      throw new ExceptionInInitializerError(failure);
    }
  }

  private static <T> T allocate(Class<T> type) throws InstantiationException {
    return type.cast(UNSAFE.allocateInstance(type));
  }

  private static Object getStatic(Field field) {
    return UNSAFE.getObjectVolatile(UNSAFE.staticFieldBase(field), UNSAFE.staticFieldOffset(field));
  }

  private static void setStatic(Field field, Object value) {
    UNSAFE.putObjectVolatile(
        UNSAFE.staticFieldBase(field), UNSAFE.staticFieldOffset(field), value);
  }

  private static void setObject(Object owner, Field field, Object value) {
    UNSAFE.putObject(owner, UNSAFE.objectFieldOffset(field), value);
  }

  private static void setInt(Object owner, Field field, int value) {
    UNSAFE.putInt(owner, UNSAFE.objectFieldOffset(field), value);
  }

  private static final class LoginMixinHarness extends ServerLoginPacketListenerImplMixin {
    private GameProfile verifiedProfile;

    private void prepare(IntegratedServer server, TestConnection connection) {
      this.server = server;
      this.connection = connection;
      this.requestedUsername = WhiteLilyBridge.WHITE_LILY_USERNAME;
    }

    @Override
    protected void startClientVerification(GameProfile profile) {
      verifiedProfile = profile;
    }
  }

  private static final class PlayerListMixinHarness extends PlayerListMixin {}

  private static final class TestConnection extends Connection
      implements BridgeConnectionAccess,
          BridgeConnectionEndpointAccess,
          BridgeConnectionApprovalAccess {
    private final HandshakeProofSlot handshake = new HandshakeProofSlot();
    private final PendingProfileApprovalSlot approval = new PendingProfileApprovalSlot();

    private TestConnection() {
      super(PacketFlow.SERVERBOUND);
    }

    @Override
    public SocketAddress getRemoteAddress() {
      return new InetSocketAddress(InetAddress.getLoopbackAddress(), PORT);
    }

    @Override
    public void whitelily$setHandshakeProof(String nonce, int port) {
      handshake.whitelily$setHandshakeProof(nonce, port);
    }

    @Override
    public Optional<HandshakeProof> whitelily$takeHandshakeProof() {
      return handshake.whitelily$takeHandshakeProof();
    }

    @Override
    public void whitelily$clearHandshakeProof() {
      handshake.whitelily$clearHandshakeProof();
    }

    @Override
    public int whitelily$localPort() {
      return PORT;
    }

    @Override
    public void whitelily$markPendingApproval(Object server, UUID profileId) {
      approval.whitelily$markPendingApproval(server, profileId);
    }

    @Override
    public boolean whitelily$hasPendingApproval(Object server, UUID profileId) {
      return approval.whitelily$hasPendingApproval(server, profileId);
    }

    @Override
    public boolean whitelily$takePendingApproval(Object server, UUID profileId) {
      return approval.whitelily$takePendingApproval(server, profileId);
    }

    @Override
    public void whitelily$clearPendingApproval() {
      approval.whitelily$clearPendingApproval();
    }
  }
}
