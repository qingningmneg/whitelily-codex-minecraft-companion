package io.github.whitelily.avatar;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

final class NativeSkinFailureDiagnosticsTest {
  @Test
  void repeatedNativeSkinFailuresEmitOneStableDiagnosticCode() {
    List<String> reportedCodes = new ArrayList<>();
    NativeSkinFailureDiagnostics diagnostics = new NativeSkinFailureDiagnostics(reportedCodes::add);

    diagnostics.report(new IllegalStateException("first catalog failure"));
    diagnostics.report(new IllegalStateException("second catalog failure"));
    diagnostics.report(new IllegalStateException("third catalog failure"));

    assertEquals(List.of("WL_AVATAR_SKIN_001"), reportedCodes);
  }

  @Test
  void diagnosticSinkFailureDoesNotEscapeTheRenderCaller() {
    NativeSkinFailureDiagnostics diagnostics =
        new NativeSkinFailureDiagnostics(
            ignored -> {
              throw new IllegalStateException("sink unavailable");
            });

    assertDoesNotThrow(() -> diagnostics.report(new IllegalStateException("catalog unavailable")));
  }
}
