package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import io.github.whitelily.bridge.mixin.ConnectionMixin;
import net.minecraft.network.Connection;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import net.minecraft.server.network.ServerLoginPacketListenerImpl;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

class TerminalLifecycleBytecodeContractTest {
  private static final String COMPONENT = "Lnet/minecraft/network/chat/Component;";
  private static final String DETAILS = "Lnet/minecraft/network/DisconnectionDetails;";
  private static final String CONNECTION = "net/minecraft/network/Connection";

  @Test
  void real1215LoginRejectionDelegatesToTheConnectionComponentDisconnect() throws Exception {
    MethodCode loginDisconnect =
        methodCode(
            ServerLoginPacketListenerImpl.class,
            "disconnect",
            "(" + COMPONENT + ")V");

    assertTrue(
        loginDisconnect.hasInvocation(
            CONNECTION, "disconnect", "(" + COMPONENT + ")V"),
        "login rejection must delegate to Connection.disconnect(Component)");
  }

  @Test
  void real1215RejectedLoginAndCaughtPlacementFailureBothReachAConnectionDisconnect()
      throws Exception {
    MethodCode configuration =
        methodCode(
            ServerConfigurationPacketListenerImpl.class,
            "handleConfigurationFinished",
            "(Lnet/minecraft/network/protocol/configuration/ServerboundFinishConfigurationPacket;)V");
    int policy =
        configuration.indexOf(
            "net/minecraft/server/players/PlayerList",
            "canPlayerLogin",
            "(Ljava/net/SocketAddress;Lcom/mojang/authlib/GameProfile;)" + COMPONENT);
    int rejection =
        configuration.indexOfAfter(
            "net/minecraft/server/network/ServerConfigurationPacketListenerImpl",
            "disconnect",
            "(" + COMPONENT + ")V",
            policy);
    int placement =
        configuration.indexOf(
            "net/minecraft/server/players/PlayerList",
            "placeNewPlayer",
            "(Lnet/minecraft/network/Connection;Lnet/minecraft/server/level/ServerPlayer;"
                + "Lnet/minecraft/server/network/CommonListenerCookie;)V");
    TryRange placementCatch = configuration.exceptionRangeCovering(placement);
    assertNotNull(placementCatch, "placeNewPlayer must be covered by the real Exception handler");
    int placementFailureDisconnect =
        configuration.indexOfAfter(
            CONNECTION,
            "disconnect",
            "(" + COMPONENT + ")V",
            placementCatch.handler());

    assertTrue(policy >= 0, "real rejection policy call");
    assertTrue(rejection > policy && rejection < placement, "rejection disconnect branch");
    assertTrue(
        placementFailureDisconnect > placementCatch.handler(),
        "caught placement failure must disconnect its Connection");
  }

  @Test
  void real1215ComponentDisconnectDelegatesToTheDetailsOverloadTargetedByTheMixin()
      throws Exception {
    MethodCode componentDisconnect =
        methodCode(Connection.class, "disconnect", "(" + COMPONENT + ")V");
    assertTrue(
        componentDisconnect.hasInvocation(CONNECTION, "disconnect", "(" + DETAILS + ")V"),
        "Connection.disconnect(Component) must delegate to Connection.disconnect(DisconnectionDetails)");

    InjectionContract injection = connectionMixinInjection();
    assertEquals("disconnect(" + DETAILS + ")V", injection.target());
    assertEquals("HEAD", injection.at());
    assertEquals(
        "(" + DETAILS + "Lorg/spongepowered/asm/mixin/injection/callback/CallbackInfo;)V",
        injection.callbackDescriptor());
  }

  @Test
  void real1215InheritedConfigurationDisconnectOverloadsReachTheConnectionDetailsTarget()
      throws Exception {
    String listener = "net/minecraft/server/network/ServerCommonPacketListenerImpl";
    MethodCode componentDisconnect =
        methodCode(ServerCommonPacketListenerImpl.class, "disconnect", "(" + COMPONENT + ")V");
    assertTrue(
        componentDisconnect.hasInvocation(listener, "disconnect", "(" + DETAILS + ")V"),
        "inherited disconnect(Component) must delegate to inherited disconnect(DisconnectionDetails)");

    MethodCode detailsDisconnect =
        methodCode(ServerCommonPacketListenerImpl.class, "disconnect", "(" + DETAILS + ")V");
    org.objectweb.asm.Handle callback = detailsDisconnect.connectionDetailsCallback();
    assertEquals(listener, callback.getOwner());
    assertEquals("(" + DETAILS + ")V", callback.getDesc());
    MethodCode callbackCode =
        methodCode(ServerCommonPacketListenerImpl.class, callback.getName(), callback.getDesc());
    assertTrue(
        callbackCode.hasInvocation(CONNECTION, "disconnect", "(" + DETAILS + ")V"),
        "inherited disconnect(DisconnectionDetails) callback must reach Connection.disconnect(DisconnectionDetails)");
  }

  private static MethodCode methodCode(
      Class<?> ownerClass, String expectedName, String expectedDescriptor) throws Exception {
    String resource = "/" + ownerClass.getName().replace('.', '/') + ".class";
    try (InputStream bytes = ownerClass.getResourceAsStream(resource)) {
      assertNotNull(bytes, resource);
      MethodCode code = new MethodCode();
      new ClassReader(bytes)
          .accept(
              new ClassVisitor(Opcodes.ASM9) {
                @Override
                public MethodVisitor visitMethod(
                    int access,
                    String name,
                    String descriptor,
                    String signature,
                    String[] exceptions) {
                  return name.equals(expectedName) && descriptor.equals(expectedDescriptor)
                      ? code.markVisited()
                      : null;
                }
              },
              0);
      assertTrue(code.visited, ownerClass.getName() + "." + expectedName + expectedDescriptor);
      return code;
    }
  }

  private static InjectionContract connectionMixinInjection() throws Exception {
    String callback = "whitelily$clearBridgeConnectionState";
    try (InputStream bytes =
        ConnectionMixin.class.getResourceAsStream(
            "/io/github/whitelily/bridge/mixin/ConnectionMixin.class")) {
      assertNotNull(bytes);
      String[] target = {null};
      String[] at = {null};
      String[] callbackDescriptor = {null};
      new ClassReader(bytes)
          .accept(
              new ClassVisitor(Opcodes.ASM9) {
                @Override
                public MethodVisitor visitMethod(
                    int access,
                    String name,
                    String descriptor,
                    String signature,
                    String[] exceptions) {
                  if (!name.equals(callback)) {
                    return null;
                  }
                  callbackDescriptor[0] = descriptor;
                  return new MethodVisitor(Opcodes.ASM9) {
                    @Override
                    public AnnotationVisitor visitAnnotation(
                        String descriptor, boolean visible) {
                      if (!descriptor.equals(
                          "Lorg/spongepowered/asm/mixin/injection/Inject;")) {
                        return null;
                      }
                      return new AnnotationVisitor(Opcodes.ASM9) {
                        @Override
                        public AnnotationVisitor visitArray(String name) {
                          if (name.equals("method")) {
                            return new AnnotationVisitor(Opcodes.ASM9) {
                              @Override
                              public void visit(String ignored, Object value) {
                                target[0] = (String) value;
                              }
                            };
                          }
                          if (name.equals("at")) {
                            return new AnnotationVisitor(Opcodes.ASM9) {
                              @Override
                              public AnnotationVisitor visitAnnotation(
                                  String ignored, String descriptor) {
                                return new AnnotationVisitor(Opcodes.ASM9) {
                                  @Override
                                  public void visit(String name, Object value) {
                                    if (name.equals("value")) {
                                      at[0] = (String) value;
                                    }
                                  }
                                };
                              }
                            };
                          }
                          return null;
                        }
                      };
                    }
                  };
                }
              },
              ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
      return new InjectionContract(target[0], at[0], callbackDescriptor[0]);
    }
  }

  private record InjectionContract(String target, String at, String callbackDescriptor) {}

  private record Invocation(String owner, String name, String descriptor, int index) {}

  private record PendingTryRange(Label start, Label end, Label handler, String type) {}

  private record TryRange(int start, int end, int handler, String type) {}

  private static final class MethodCode extends MethodVisitor {
    private final List<Invocation> invocations = new ArrayList<>();
    private final List<org.objectweb.asm.Handle> invokedynamicTargets = new ArrayList<>();
    private final List<PendingTryRange> pendingTryRanges = new ArrayList<>();
    private final Map<Label, Integer> labels = new IdentityHashMap<>();
    private int instruction;
    private boolean visited;

    private MethodCode() {
      super(Opcodes.ASM9);
    }

    private MethodCode markVisited() {
      visited = true;
      return this;
    }

    @Override
    public void visitLabel(Label label) {
      labels.put(label, instruction);
    }

    @Override
    public void visitTryCatchBlock(
        Label start, Label end, Label handler, String type) {
      pendingTryRanges.add(new PendingTryRange(start, end, handler, type));
    }

    @Override
    public void visitMethodInsn(
        int opcode, String owner, String name, String descriptor, boolean isInterface) {
      invocations.add(new Invocation(owner, name, descriptor, instruction));
      instruction++;
    }

    @Override
    public void visitInsn(int opcode) {
      instruction++;
    }

    @Override
    public void visitIntInsn(int opcode, int operand) {
      instruction++;
    }

    @Override
    public void visitVarInsn(int opcode, int variable) {
      instruction++;
    }

    @Override
    public void visitTypeInsn(int opcode, String type) {
      instruction++;
    }

    @Override
    public void visitFieldInsn(int opcode, String owner, String name, String descriptor) {
      instruction++;
    }

    @Override
    public void visitJumpInsn(int opcode, Label label) {
      instruction++;
    }

    @Override
    public void visitLdcInsn(Object value) {
      instruction++;
    }

    @Override
    public void visitIincInsn(int variable, int increment) {
      instruction++;
    }

    @Override
    public void visitInvokeDynamicInsn(
        String name,
        String descriptor,
        org.objectweb.asm.Handle bootstrapMethodHandle,
        Object... bootstrapMethodArguments) {
      for (Object argument : bootstrapMethodArguments) {
        if (argument instanceof org.objectweb.asm.Handle handle) {
          invokedynamicTargets.add(handle);
        }
      }
      instruction++;
    }

    org.objectweb.asm.Handle connectionDetailsCallback() {
      return invokedynamicTargets.stream()
          .filter(
              target ->
                  target
                      .getOwner()
                      .equals("net/minecraft/server/network/ServerCommonPacketListenerImpl")
                      && target.getDesc().equals("(" + DETAILS + ")V"))
          .findFirst()
          .orElseThrow(
              () ->
                  new AssertionError(
                      "disconnect(DisconnectionDetails) must retain a Connection-details callback"));
    }

    boolean hasInvocation(String owner, String name, String descriptor) {
      return indexOf(owner, name, descriptor) >= 0;
    }

    int indexOf(String owner, String name, String descriptor) {
      return indexOfAfter(owner, name, descriptor, -1);
    }

    int indexOfAfter(String owner, String name, String descriptor, int after) {
      return invocations.stream()
          .filter(
              invocation ->
                  invocation.index() > after
                      && invocation.owner().equals(owner)
                      && invocation.name().equals(name)
                      && invocation.descriptor().equals(descriptor))
          .mapToInt(Invocation::index)
          .findFirst()
          .orElse(-1);
    }

    TryRange exceptionRangeCovering(int index) {
      return pendingTryRanges.stream()
          .map(
              range ->
                  new TryRange(
                      labels.getOrDefault(range.start(), -1),
                      labels.getOrDefault(range.end(), -1),
                      labels.getOrDefault(range.handler(), -1),
                      range.type()))
          .filter(
              range ->
                  range.type().equals("java/lang/Exception")
                      && range.start() <= index
                      && index < range.end())
          .findFirst()
          .orElse(null);
    }
  }
}
