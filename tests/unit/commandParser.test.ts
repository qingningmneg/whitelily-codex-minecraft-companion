import { describe, expect, it } from "vitest";
import { parseLocalCommand } from "../../src/commands/commandParser.js";

describe("parseLocalCommand", () => {
  it.each([
    ["!mode friend", { kind: "mode", mode: "friend" }],
    ["进入平衡模式", { kind: "mode", mode: "balanced" }],
    ["你自己去探索吧", { kind: "mode", mode: "autonomous" }],
    ["!stop", { kind: "stop" }],
    ["!allow 17", { kind: "allow", confirmationId: 17 }],
    ["!memory forget 8", { kind: "memory_forget", memoryId: 8 }],
  ])("parses %s", (input, expected) => {
    expect(parseLocalCommand(input)).toEqual(expected);
  });

  it.each([
    ["!pause", { kind: "pause" }],
    ["!resume", { kind: "resume" }],
    ["!status", { kind: "status" }],
    ["!deny 23", { kind: "deny", confirmationId: 23 }],
    ["!memory show", { kind: "memory_show" }],
    ["!memory clear", { kind: "memory_clear" }],
    ["!memory search diamonds", { kind: "memory_search", query: "diamonds" }],
  ])("parses explicit command %s", (input, expected) => {
    expect(parseLocalCommand(input)).toEqual(expected);
  });

  it.each([
    [" \t!MoDe FRIEND\n", { kind: "mode", mode: "friend" }],
    ["  进入朋友模式  ", { kind: "mode", mode: "friend" }],
    ["\n进入自主模式\t", { kind: "mode", mode: "autonomous" }],
    ["  先停一下  ", { kind: "pause" }],
    ["\t!StAtUs\n", { kind: "status" }],
    ["  !MeMoRy SeArCh   ancient\t\n  city  ", { kind: "memory_search", query: "ancient city" }],
    ["!allow 9007199254740991", { kind: "allow", confirmationId: 9007199254740991 }],
    ["!memory forget 9007199254740991", { kind: "memory_forget", memoryId: 9007199254740991 }],
  ])("normalizes valid input %s", (input, expected) => {
    expect(parseLocalCommand(input)).toEqual(expected);
  });

  it.each([
    "!mode",
    "!mode curious",
    "!pause now",
    "!allow",
    "!allow -1",
    "!allow 9007199254740992",
    "!deny 9007199254740992",
    "!memory forget",
    "!memory forget 9007199254740992",
    "!memory search",
    "!memory search    ",
  ])("rejects invalid or incomplete command %s", (input) => {
    expect(parseLocalCommand(input)).toBeNull();
  });

  it("returns null for ordinary conversation", () => {
    expect(parseLocalCommand("白百合，今天想做什么？")).toBeNull();
  });

  it.each([
    "不要进入朋友模式",
    "别进入平衡模式",
    "不要进入自主模式",
    "“进入自主模式”是什么意思？",
    "你自己去探索吧？",
    "你自己去探索吧？不，算了",
    "请进入平衡模式然后跟我走",
    "前缀进入朋友模式",
    "进入自主模式后缀",
  ])("does not switch mode for negative, quoted, questioned, or compound text: %s", (input) => {
    expect(parseLocalCommand(input)).toBeNull();
  });
});
