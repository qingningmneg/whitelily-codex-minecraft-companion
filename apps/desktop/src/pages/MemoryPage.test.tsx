import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteLilyTask5Api } from "../desktopApi.js";
import { MemoryPage } from "./MemoryPage.js";

const manual = {
  id: 1,
  category: "preference" as const,
  summary: "Use spruce for roofs",
  importance: 4 as const,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  scope: "global" as const,
  source: "manual" as const,
  pinned: false,
  revision: 0,
};
const automatic = {
  ...manual,
  id: 2,
  summary: "Village is north",
  source: "automatic" as const,
};
const memories = {
  schemaVersion: 1 as const,
  revision: 5,
  updatedAt: "2026-07-29T00:00:00.000Z",
  records: [manual, automatic],
  legacyMigrated: true,
};

function api(overrides: Partial<WhiteLilyTask5Api> = {}): WhiteLilyTask5Api {
  return {
    readMemories: vi.fn(async () => memories),
    searchMemories: vi.fn(async () => ({ ...memories, records: [manual] })),
    addMemory: vi.fn(async () => ({ envelope: { ...memories, revision: 6 }, record: manual })),
    updateMemory: vi.fn(async () => ({
      envelope: { ...memories, revision: 6 },
      record: { ...manual, summary: "Updated roof preference", revision: 1 },
    })),
    forgetMemory: vi.fn(async () => ({
      envelope: { ...memories, revision: 6, records: [automatic] },
      record: manual,
    })),
    pinMemory: vi.fn(async () => ({
      envelope: { ...memories, revision: 6 },
      record: { ...manual, pinned: true, revision: 1 },
    })),
    exportMemories: vi.fn(async () => ({ status: "saved" as const })),
    readWorldProfile: vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 0,
      updatedAt: "2026-07-29T00:00:00.000Z",
      value: null,
    })),
    setMemoryScope: vi.fn(async () => ({
      revision: 1,
      lifecycle: "running" as const,
      minecraft: { state: "connected" as const, sessionId: "session" },
      codex: { state: "ready" as const, model: "live-model" },
      actions: {
        state: "ready" as const,
        workspaceVersion: "workspace-1",
        mcpListening: true as const,
        discoveredToolCount: 15,
      },
      task: null,
      actionQueue: { goal: null, items: [] },
      lastError: null,
    })),
    previewMemoryMigration: vi.fn(async (scope) => ({
      migrationId: "migration_opaque_1234",
      sourceRevision: 5,
      targetScope: scope,
      deduplicatedCount: 0,
      movedCount: 2,
    })),
    commitMemoryMigration: vi.fn(async ({ migrationId }) => ({
      migrationId,
      status: "committed" as const,
    })),
    rollbackMemoryMigration: vi.fn(async (migrationId) => ({
      migrationId,
      status: "rolled_back" as const,
    })),
    ...overrides,
  } as WhiteLilyTask5Api;
}

describe("MemoryPage", () => {
  afterEach(cleanup);

  it("adds, edits, deletes, pins, searches, and exports through revision-checked commands", async () => {
    const desktopApi = api();
    render(<MemoryPage api={desktopApi} locale="en" currentWorldId="world_1" />);
    expect(await screen.findByText("Use spruce for roofs")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("New memory"), "Bring torches");
    await userEvent.click(screen.getByRole("button", { name: "Add memory" }));
    expect(desktopApi.addMemory).toHaveBeenCalledWith({
      expectedRevision: 5,
      memory: {
        category: "preference",
        importance: 3,
        scope: "global",
        summary: "Bring torches",
      },
    });

    const manualRow = screen.getByRole("listitem", { name: "Use spruce for roofs" });
    await userEvent.click(within(manualRow).getByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByLabelText("Edit memory"));
    await userEvent.type(screen.getByLabelText("Edit memory"), "Updated roof preference");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(desktopApi.updateMemory).toHaveBeenCalledWith({
      expectedRevision: 6,
      id: 1,
      patch: { scope: "global", summary: "Updated roof preference" },
      recordRevision: 0,
    });

    await userEvent.click(within(manualRow).getByRole("button", { name: "Pin" }));
    expect(desktopApi.pinMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, pinned: true, recordRevision: 0 }),
    );
    const automaticRow = screen.getByRole("listitem", { name: "Village is north" });
    expect(
      (
        within(automaticRow).getByRole("button", {
          name: "Automatic memories cannot be pinned",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search memories" }), "spruce");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(desktopApi.searchMemories).toHaveBeenCalledWith({
      query: "spruce",
      scope: { mode: "layered", worldId: "world_1" },
    });

    await userEvent.click(within(manualRow).getByRole("button", { name: "Delete" }));
    expect(desktopApi.forgetMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, recordRevision: 0 }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Export memories" }));
    expect(desktopApi.exportMemories).toHaveBeenCalledWith();
  });

  it("previews scope counts before explicit apply and offers explicit rollback", async () => {
    const setMemoryScope = vi.fn<WhiteLilyTask5Api["setMemoryScope"]>(async () => ({
      revision: 1,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: "session" },
      codex: { state: "ready", model: "live-model" },
      actions: {
        state: "ready",
        workspaceVersion: "workspace-1",
        mcpListening: true,
        discoveredToolCount: 15,
      },
      task: null,
      actionQueue: { goal: null, items: [] },
      lastError: null,
    }));
    render(
      <MemoryPage
        api={api({ setMemoryScope })}
        locale="en"
        currentWorldId="world_1"
        initialScope={{ mode: "global" }}
      />,
    );
    await screen.findByText("Use spruce for roofs");

    await userEvent.selectOptions(screen.getByLabelText("Memory scope"), "layered");
    expect(screen.getByText("2 memories will be available")).toBeTruthy();
    expect(setMemoryScope).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Apply scope" }));
    expect(setMemoryScope).toHaveBeenCalledWith({ mode: "layered", worldId: "world_1" });
    await userEvent.click(screen.getByRole("button", { name: "Rollback scope change" }));
    await waitFor(() => expect(setMemoryScope).toHaveBeenLastCalledWith({ mode: "global" }));
  });

  it("previews, commits, and rolls back an exact child-owned memory migration", async () => {
    const desktopApi = api();
    render(<MemoryPage api={desktopApi} locale="en" currentWorldId="world_1" />);
    await screen.findByText("Use spruce for roofs");

    await userEvent.selectOptions(screen.getByLabelText("Migration target"), "world");
    await userEvent.click(screen.getByRole("button", { name: "Preview migration" }));
    expect(desktopApi.previewMemoryMigration).toHaveBeenCalledWith("world");
    expect(
      await screen.findByText("2 memories will move; 0 duplicates will be removed"),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Commit migration" }));
    expect(desktopApi.commitMemoryMigration).toHaveBeenCalledWith({
      migrationId: "migration_opaque_1234",
      sourceRevision: 5,
    });

    await userEvent.click(screen.getByRole("button", { name: "Rollback migration" }));
    expect(desktopApi.rollbackMemoryMigration).toHaveBeenCalledWith("migration_opaque_1234");
  });

  it("discovers the authoritative bound world when opened from the application route", async () => {
    const desktopApi = api({
      readWorldProfile: vi.fn(async () => ({
        schemaVersion: 1 as const,
        revision: 2,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: {
          id: "12345678-1234-4234-8234-123456789abc",
          label: "Survival",
          instanceFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          ownerUsername: "Player",
          safetyPreset: "conservative" as const,
        },
      })),
    });

    render(<MemoryPage api={desktopApi} locale="en" />);

    await screen.findByText("Use spruce for roofs");
    const scope = screen.getByLabelText("Memory scope") as HTMLSelectElement;
    expect(scope.value).toBe("layered");
    expect(
      (within(scope).getByRole("option", { name: "Current world" }) as HTMLOptionElement).disabled,
    ).toBe(false);
  });

  it("creates and moves manual memories with an explicit stored scope but no renderer world ID", async () => {
    const worldId = "12345678-1234-4234-8234-123456789abc";
    const desktopApi = api({
      readWorldProfile: vi.fn(async () => ({
        schemaVersion: 1 as const,
        revision: 2,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: {
          id: worldId,
          label: "Survival",
          instanceFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          ownerUsername: "Player",
          safetyPreset: "conservative" as const,
        },
      })),
    });
    render(<MemoryPage api={desktopApi} locale="en" />);
    await screen.findByText("Use spruce for roofs");

    await userEvent.selectOptions(screen.getByLabelText("New memory storage"), "world");
    await userEvent.type(screen.getByLabelText("New memory"), "World-only mine");
    await userEvent.click(screen.getByRole("button", { name: "Add memory" }));
    expect(desktopApi.addMemory).toHaveBeenCalledWith({
      expectedRevision: 5,
      memory: {
        category: "preference",
        importance: 3,
        scope: "world",
        summary: "World-only mine",
      },
    });

    const manualRow = screen.getByRole("listitem", { name: "Use spruce for roofs" });
    await userEvent.click(within(manualRow).getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(screen.getByLabelText("Memory storage"), "world");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(desktopApi.updateMemory).toHaveBeenCalledWith({
      expectedRevision: 6,
      id: 1,
      patch: { scope: "world", summary: "Use spruce for roofs" },
      recordRevision: 0,
    });
  });

  it("moves a world memory to global and fails closed on world storage without a bound world", async () => {
    const worldRecord = {
      ...manual,
      scope: "world" as const,
      worldId: "12345678-1234-4234-8234-123456789abc",
    };
    const desktopApi = api({
      readMemories: vi.fn(async () => ({ ...memories, records: [worldRecord] })),
      updateMemory: vi.fn(async () => ({
        envelope: { ...memories, revision: 6, records: [{ ...manual, revision: 1 }] },
        record: { ...manual, revision: 1 },
      })),
    });
    render(<MemoryPage api={desktopApi} locale="en" />);
    const row = await screen.findByRole("listitem", { name: "Use spruce for roofs" });
    const newScope = screen.getByLabelText("New memory storage") as HTMLSelectElement;
    expect(
      (within(newScope).getByRole("option", { name: "Current world" }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);

    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(screen.getByLabelText("Memory storage"), "global");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(desktopApi.updateMemory).toHaveBeenCalledWith({
      expectedRevision: 5,
      id: 1,
      patch: { scope: "global", summary: "Use spruce for roofs" },
      recordRevision: 0,
    });
  });
});
