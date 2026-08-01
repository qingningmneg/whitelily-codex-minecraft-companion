import { describe, expect, it } from "vitest";
import { createRedactedMemoryExport } from "../../src/memory/memoryExport.js";

const createdAt = "2026-07-29T00:00:00.000Z";
const windowsProfile = ["C:", "Users", "Owner"].join("\\");

describe("redacted memory export", () => {
  it.each([
    ["Windows path", `Project lives at ${windowsProfile}\\private\\world`, windowsProfile],
    ["local path", "/home/owner/private/world", "/home/owner"],
    ["bearer token", "Authorization: Bearer abc+private==", "abc+private"],
    ["credential assignment", "password=hunter2", "hunter2"],
    ["URI credentials", "redis://player:private-password@localhost:6379/world", "private-password"],
    ["raw chat marker", "玩家：今晚去秘密基地", "今晚去秘密基地"],
    ["reasoning marker", "模型推理：因为隐藏坐标很重要", "因为隐藏坐标很重要"],
  ])("removes %s from the final serialized artifact", (_case, summary, forbidden) => {
    const exported = createRedactedMemoryExport({
      schemaVersion: 1,
      revision: 7,
      updatedAt: createdAt,
      legacyMigrated: true,
      records: [
        {
          id: 1,
          category: "experience",
          summary,
          importance: 4,
          createdAt,
          updatedAt: createdAt,
          scope: "global",
          source: "manual",
          pinned: false,
          revision: 0,
        },
      ],
    });

    const artifact = JSON.stringify(exported);
    expect(artifact).not.toContain(forbidden);
    expect(artifact).not.toContain(summary);
  });

  it("redacts historical migrated records instead of trusting insertion-time validation", () => {
    const legacySummary = `玩家：备份在 ${windowsProfile}\\legacy，TOKEN=legacy-secret`;
    const exported = createRedactedMemoryExport({
      schemaVersion: 1,
      revision: 3,
      updatedAt: createdAt,
      legacyMigrated: true,
      records: [
        {
          id: 42,
          category: "experience",
          summary: legacySummary,
          importance: 3,
          createdAt,
          updatedAt: createdAt,
          scope: "global",
          source: "automatic",
          pinned: false,
          revision: 0,
        },
      ],
    });

    const artifact = JSON.stringify(exported);
    expect(artifact).not.toContain("C:\\Users\\Owner");
    expect(artifact).not.toContain("legacy-secret");
    expect(artifact).not.toContain("备份在");
  });

  it("omits a historical renderer-controlled world ID from the complete public artifact", () => {
    const historicalWorldId = ["sk", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
    const exported = createRedactedMemoryExport({
      schemaVersion: 1,
      revision: 9,
      updatedAt: createdAt,
      legacyMigrated: true,
      records: [
        {
          id: 7,
          category: "place",
          summary: "Village square",
          importance: 3,
          createdAt,
          updatedAt: createdAt,
          scope: "world",
          worldId: historicalWorldId,
          source: "manual",
          pinned: false,
          revision: 0,
        },
      ],
    });

    const artifact = JSON.stringify(exported);
    expect(artifact).not.toContain(historicalWorldId);
    expect(exported.records).toEqual([
      expect.objectContaining({ id: 7, scope: "world", summary: "Village square" }),
    ]);
  });
});
