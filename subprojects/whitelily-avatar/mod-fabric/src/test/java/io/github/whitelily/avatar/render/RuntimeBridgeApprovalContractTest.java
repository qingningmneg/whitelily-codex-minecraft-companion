package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class RuntimeBridgeApprovalContractTest {
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
