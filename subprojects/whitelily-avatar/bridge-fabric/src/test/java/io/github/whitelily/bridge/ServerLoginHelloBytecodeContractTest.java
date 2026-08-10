package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.server.network.ServerLoginPacketListenerImpl;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

class ServerLoginHelloBytecodeContractTest {
  @Test
  void real1215HelloValidatesStateAndNameBeforeAssigningTheUsernameAndCanBeCalledOnlyOnce() throws Exception {
    List<String> events = new ArrayList<>();
    try (InputStream bytes = ServerLoginPacketListenerImpl.class.getResourceAsStream(
        "/net/minecraft/server/network/ServerLoginPacketListenerImpl.class")) {
      new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
        @Override
        public MethodVisitor visitMethod(
            int access, String name, String descriptor, String signature, String[] exceptions) {
          if (!name.equals("handleHello")
              || !descriptor.equals("(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V")) {
            return null;
          }
          return new MethodVisitor(Opcodes.ASM9) {
            @Override
            public void visitLdcInsn(Object value) {
              if (value instanceof String text
                  && (text.equals("Unexpected hello packet") || text.equals("Invalid characters in username"))) {
                events.add(text);
              }
            }

            @Override
            public void visitFieldInsn(int opcode, String owner, String name, String descriptor) {
              if (opcode == Opcodes.PUTFIELD
                  && owner.equals("net/minecraft/server/network/ServerLoginPacketListenerImpl")
                  && name.equals("requestedUsername")
                  && descriptor.equals("Ljava/lang/String;")) {
                events.add("requestedUsername=");
              }
            }
          };
        }
      }, 0);
    }

    assertEquals(
        List.of("Unexpected hello packet", "Invalid characters in username", "requestedUsername="), events);
    assertTrue(events.indexOf("Unexpected hello packet") < events.indexOf("requestedUsername="));
  }
}
