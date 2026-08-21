package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.control.AvatarModelControlRequest;
import io.github.whitelily.avatar.control.AvatarModelControlState;
import io.github.whitelily.avatar.control.AvatarModelController;
import io.github.whitelily.avatar.control.AvatarModelOperation;
import io.github.whitelily.avatar.control.AvatarModelPhase;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.skin.NativeSkinCandidateRuntime;
import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class RuntimeBridgeApprovalContractTest {
  @Test
  void builtinNativeSkinCompletesOneVisibleFrame() {
    AvatarRuntimeDescriptor descriptor = descriptor("builtin:whitelily", "minecraft-skin");
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();
    List<AvatarModelControlState> states = new ArrayList<>();
    AvatarModelController controller =
        new AvatarModelController(runtime, states::add, "builtin:whitelily", "world-0001");
    controller.accept(
        new AvatarModelControlRequest(
            1,
            "switch-0001",
            AvatarModelOperation.PREPARE,
            descriptor.modelId(),
            "world-0001",
            descriptor,
            Instant.parse("2026-08-21T08:00:00Z")));
    controller.tick();
    controller.accept(
        new AvatarModelControlRequest(
            1,
            "switch-0001",
            AvatarModelOperation.COMMIT,
            descriptor.modelId(),
            "world-0001",
            null,
            Instant.parse("2026-08-21T08:00:01Z")));

    WhiteLilyAvatarClient.onRenderBoundary(controller);
    WhiteLilyAvatarClient.onNativeSkinFrameVisible(runtime, controller);
    WhiteLilyAvatarClient.onNativeSkinFrameVisible(runtime, controller);

    assertEquals(descriptor.modelId(), controller.confirmedActiveModelId());
    assertEquals(
        1,
        states.stream().filter(state -> state.phase() == AvatarModelPhase.COMMITTED).count());
  }

  private static AvatarRuntimeDescriptor descriptor(String modelId, String worldRenderer) {
    return new AvatarRuntimeDescriptor(
        modelId,
        "builtin",
        worldRenderer,
        "slim");
  }

  @Test
  void productionCaptureUsesOnlyTheReadOnlyBridgeApprovalInsteadOfScoreboardAuthority()
      throws Exception {
    List<String> authorityCalls = new ArrayList<>();
    try (InputStream bytes =
        WhiteLilyRenderRuntime.class.getResourceAsStream("/io/github/whitelily/avatar/render/WhiteLilyRenderRuntime.class")) {
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
                  if (!name.equals("captureDecision")) {
                    return null;
                  }
                  return new MethodVisitor(Opcodes.ASM9) {
                    @Override
                    public void visitMethodInsn(
                        int opcode,
                        String owner,
                        String name,
                        String descriptor,
                        boolean isInterface) {
                      if (owner.equals("io/github/whitelily/bridge/WhiteLilyBridge")
                          || name.equals("getTeam")) {
                        authorityCalls.add(
                            opcode + ":" + owner + ":" + name + ":" + descriptor);
                      }
                    }
                  };
                }
              },
              0);
    }

    assertEquals(
        List.of(
            Opcodes.INVOKESTATIC
                + ":io/github/whitelily/bridge/WhiteLilyBridge:isApprovedProfile:"
                + "(Ljava/util/UUID;Ljava/lang/String;)Z"),
        authorityCalls);
    assertFalse(authorityCalls.stream().anyMatch(call -> call.contains(":getTeam:")));
  }
}
