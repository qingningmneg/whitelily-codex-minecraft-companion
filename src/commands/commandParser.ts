import type { CompanionMode } from "../domain/types.js";

export type LocalCommand =
  | { kind: "mode"; mode: CompanionMode }
  | { kind: "pause" | "resume" | "stop" | "status" }
  | { kind: "allow" | "deny"; confirmationId: number }
  | { kind: "memory_show" | "memory_clear" }
  | { kind: "memory_search"; query: string }
  | { kind: "memory_forget"; memoryId: number };

function parseSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const modeAliases: Array<[RegExp, CompanionMode]> = [
  [/^!mode\s+friend$/i, "friend"],
  [/^!mode\s+balanced$/i, "balanced"],
  [/^!mode\s+autonomous$/i, "autonomous"],
  [/^进入朋友模式$/, "friend"],
  [/^进入平衡模式$/, "balanced"],
  [/^(?:你自己去探索吧|进入自主模式)$/, "autonomous"],
];

export function parseLocalCommand(input: string): LocalCommand | null {
  const message = input.trim();
  for (const [pattern, mode] of modeAliases) {
    if (pattern.test(message)) return { kind: "mode", mode };
  }
  if (/^!pause$/i.test(message) || message === "先停一下") return { kind: "pause" };
  if (/^!resume$/i.test(message)) return { kind: "resume" };
  if (/^!stop$/i.test(message)) return { kind: "stop" };
  if (/^!status$/i.test(message)) return { kind: "status" };
  const allow = /^!(allow|deny)\s+(\d+)$/i.exec(message);
  if (allow) {
    const confirmationId = parseSafeInteger(allow[2]!);
    if (confirmationId === null) return null;
    return {
      kind: allow[1]!.toLowerCase() as "allow" | "deny",
      confirmationId,
    };
  }
  if (/^!memory show$/i.test(message)) return { kind: "memory_show" };
  if (/^!memory clear$/i.test(message)) return { kind: "memory_clear" };
  const search = /^!memory search\s+([\s\S]+)$/i.exec(message);
  if (search) {
    return { kind: "memory_search", query: search[1]!.trim().replace(/\s+/g, " ") };
  }
  const forget = /^!memory forget\s+(\d+)$/i.exec(message);
  if (forget) {
    const memoryId = parseSafeInteger(forget[1]!);
    if (memoryId === null) return null;
    return { kind: "memory_forget", memoryId };
  }
  return null;
}
