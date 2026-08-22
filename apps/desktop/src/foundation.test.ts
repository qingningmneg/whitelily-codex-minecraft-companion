import desktopPackage from "../package.json";
import { describe, expect, it } from "vitest";

describe("desktop foundation", () => {
  it("uses the stable WhiteLily product identity", () => {
    expect(desktopPackage.name).toBe("@whitelily/desktop");
    expect(desktopPackage.version).toBe("0.2.0-beta.2");
    expect(desktopPackage.private).toBe(true);
  });
});
