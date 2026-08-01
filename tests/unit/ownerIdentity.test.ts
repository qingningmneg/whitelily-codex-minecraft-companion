import { describe, expect, it } from "vitest";
import { parseMinecraftJavaUsername } from "../../src/identity/ownerIdentity.js";

describe("parseMinecraftJavaUsername", () => {
  it.each(["abc", "Player_123", "A".repeat(16)])("accepts %s", (value) => {
    expect(parseMinecraftJavaUsername(value, "WhiteLily")).toBe(value);
  });

  it.each([
    "ab",
    "A".repeat(17),
    "玩家",
    "Player Name",
    "YourMcName",
    "YOURMCNAME",
    "yourmcname",
    "whitelily",
    "WhItElIlY",
  ])("rejects %s", (value) =>
    expect(() => parseMinecraftJavaUsername(value, "WhiteLily")).toThrow(),
  );

  it("trims surrounding space while preserving valid username case", () => {
    expect(parseMinecraftJavaUsername("  eDiTeDOwner  ", "WhiteLily")).toBe("eDiTeDOwner");
  });
});
