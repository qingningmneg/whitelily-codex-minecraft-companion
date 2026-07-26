import { describe, expect, it } from "vitest";
import { selectModel } from "../../src/codex/modelSelector.js";

describe("selectModel", () => {
  it("prefers the configured Terra model when it is available", () => {
    expect(selectModel(["gpt-5.6-luna", "gpt-5.6-terra"], "gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });

  it("falls back to Luna before Sol when the configured model is unavailable", () => {
    expect(selectModel(["gpt-5.6-sol", "gpt-5.6-luna"], "missing")).toBe("gpt-5.6-luna");
  });

  it("never chooses Sol automatically", () => {
    expect(() => selectModel(["gpt-5.6-sol"], "missing")).toThrow("no compatible fast Codex model");
  });

  it("does not honor a configured slow or unknown model", () => {
    expect(selectModel(["gpt-9-future", "gpt-5.6-luna"], "gpt-9-future")).toBe("gpt-5.6-luna");
  });
});
