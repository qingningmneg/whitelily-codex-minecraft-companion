package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Optional;
import org.junit.jupiter.api.Test;

class BridgeAuthorizationPolicyTest {
  private static final String NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  @Test
  void acceptsOnlyTheLiteralPolicyFixture() {
    assertTrue(BridgeAuthorizationPolicy.authorize(validRequest(), validContext()).isPresent());
  }

  @Test
  void rejectsEverySingleFieldMutation() {
    record PolicyCase(BridgeRequest request, BridgeAuthorizationContext context) {}

    PolicyCase accepted = new PolicyCase(validRequest(), validContext());
    PolicyCase[] rejected = {
      new PolicyCase(new BridgeRequest(2, "WhiteLily", 49152, 1000, 31000, NONCE), validContext()),
      new PolicyCase(new BridgeRequest(1, "whiteLily", 49152, 1000, 31000, NONCE), validContext()),
      new PolicyCase(new BridgeRequest(1, "WhiteLily", 49153, 1000, 31000, NONCE), validContext()),
      new PolicyCase(new BridgeRequest(1, "WhiteLily", 49152, 1001, 31000, NONCE), validContext()),
      new PolicyCase(new BridgeRequest(1, "WhiteLily", 49152, 1501, 31501, NONCE), validContext()),
      new PolicyCase(new BridgeRequest(1, "WhiteLily", 49152, 1000, 1000, NONCE), validContext()),
      new PolicyCase(new BridgeRequest(1, "WhiteLily", 49152, 1000, 31000, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), validContext()),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(false, true, 49152, 49152, "WhiteLily", 1500)),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(true, false, 49152, 49152, "WhiteLily", 1500)),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(true, true, 49153, 49152, "WhiteLily", 1500)),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(true, true, 49152, 49153, "WhiteLily", 1500)),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(true, true, 49152, 49152, "whiteLily", 1500)),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(true, true, 49152, 49152, "WhiteLily", 999)),
      new PolicyCase(validRequest(), new BridgeAuthorizationContext(true, true, 49152, 49152, "WhiteLily", 31000)),
    };

    for (PolicyCase rejectedCase : rejected) {
      assertEquals(Optional.empty(), BridgeAuthorizationPolicy.authorize(rejectedCase.request(), rejectedCase.context()));
    }
    assertTrue(BridgeAuthorizationPolicy.authorize(accepted.request(), accepted.context()).isPresent());
  }

  private static BridgeRequest validRequest() {
    return new BridgeRequest(1, "WhiteLily", 49152, 1000, 31000, NONCE);
  }

  private static BridgeAuthorizationContext validContext() {
    return new BridgeAuthorizationContext(true, true, 49152, 49152, "WhiteLily", 1500);
  }
}
