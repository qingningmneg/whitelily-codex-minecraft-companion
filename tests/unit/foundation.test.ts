import { describe, expect, it } from "vitest";
import { APP_NAME, APP_VERSION } from "../../src/index.js";

describe("project foundation", () => {
  it("exports stable application metadata", () => {
    expect(APP_NAME).toBe("whitelily-codex-minecraft-companion");
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
