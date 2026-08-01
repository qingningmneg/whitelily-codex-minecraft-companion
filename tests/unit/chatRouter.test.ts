import { describe, expect, it } from "vitest";
import { ChatRouter } from "../../src/companion/chatRouter.js";

describe("ChatRouter", () => {
  const router = new ChatRouter({ ownerUsername: () => "TestOwner", maxMessageLength: 4_000 });

  it("routes the next chat event using the current owner", () => {
    let owner = "OldOwner";
    const dynamicRouter = new ChatRouter({
      ownerUsername: () => owner,
      maxMessageLength: 4_000,
    });

    expect(
      dynamicRouter.route({ kind: "chat", username: "OldOwner", message: "!status" }).kind,
    ).toBe("command");
    owner = "NewOwner";
    expect(dynamicRouter.route({ kind: "chat", username: "OldOwner", message: "!status" })).toEqual(
      {
        kind: "ignore",
      },
    );
    expect(
      dynamicRouter.route({ kind: "chat", username: "NewOwner", message: "!status" }).kind,
    ).toBe("command");
  });

  it("ignores another player's management command", () => {
    expect(router.route({ kind: "chat", username: "Visitor", message: "!stop" })).toEqual({
      kind: "ignore",
    });
  });

  it("requires an exact case-sensitive owner username", () => {
    expect(router.route({ kind: "chat", username: "testowner", message: "hello" })).toEqual({
      kind: "ignore",
    });
  });

  it("ignores non-chat events", () => {
    expect(router.route({ kind: "death" })).toEqual({ kind: "ignore" });
  });

  it("returns a parsed owner command before treating it as owner text", () => {
    expect(router.route({ kind: "chat", username: "TestOwner", message: "!status" })).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
  });

  it("normalizes CR and LF in owner text", () => {
    expect(
      router.route({
        kind: "chat",
        username: "TestOwner",
        message: "first\r\nsecond\nthird\rfourth",
      }),
    ).toEqual({ kind: "owner_text", text: "first  second third fourth" });
  });

  it("bounds owner text by Unicode code points", () => {
    expect(
      router.route({ kind: "chat", username: "TestOwner", message: "🐭".repeat(5_000) }),
    ).toEqual({ kind: "owner_text", text: "🐭".repeat(4_000) });
  });
});
