import { describe, expect, it } from "vitest";
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_LINE_BYTES,
  parseDesktopEvent,
  parseDesktopCommandResult,
  parseDesktopRequest,
  parseDesktopResponse,
} from "../../src/desktop/desktopProtocol.js";
import { createDefaultCompanionProfile } from "../../src/profile/profileSchema.js";

const idleSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  task: null,
  lastError: null,
} as const;

describe("desktop protocol v1", () => {
  it("parses only strict owner identity read and revision-checked update commands", () => {
    const read = { kind: "read_owner_identity" as const };
    const update = {
      kind: "update_owner_identity" as const,
      expectedRevision: 2,
      ownerUsername: "NewOwner",
    };

    expect(
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-read",
        command: read,
      }),
    ).toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "owner-read",
      command: read,
    });
    expect(
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-update",
        command: update,
      }).command,
    ).toEqual(update);

    for (const command of [
      { ...update, expectedRevision: -1 },
      { ...update, expectedRevision: 1.5 },
      { ...update, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...update, ownerUsername: "玩家" },
      { ...update, ownerUsername: "ab" },
      { ...update, ownerUsername: "a".repeat(17) },
      { ...update, ownerUsername: "YourMcName" },
      { ...update, configPath: String.raw`C:\private\config.toml` },
      { ...update, configToml: "[minecraft]" },
      { ...update, token: "secret" },
    ]) {
      expect(() =>
        parseDesktopRequest({
          version: DESKTOP_PROTOCOL_VERSION,
          id: "owner-invalid",
          command,
        }),
      ).toThrow("invalid desktop request");
    }
  });

  it.each(["version", "id", "command"] as const)(
    "rejects a request envelope with inherited %s",
    (field) => {
      const request: Record<string, unknown> = {
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-inherited-envelope",
        command: { kind: "read_owner_identity" },
      };
      const inheritedValue = request[field];
      Reflect.deleteProperty(request, field);
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let parseError: unknown;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          enumerable: true,
          value: inheritedValue,
          writable: true,
        });
        try {
          parseDesktopRequest(request);
        } catch (error) {
          parseError = error;
        }
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(Object.prototype, field);
        } else {
          Object.defineProperty(Object.prototype, field, previous);
        }
      }

      expect(parseError).toEqual(new Error("invalid desktop request"));
    },
  );

  it.each(["kind", "expectedRevision", "ownerUsername"] as const)(
    "rejects an owner update command with inherited %s",
    (field) => {
      const command: Record<string, unknown> = {
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      };
      const inheritedValue = command[field];
      Reflect.deleteProperty(command, field);
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let parseError: unknown;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          enumerable: true,
          value: inheritedValue,
          writable: true,
        });
        try {
          parseDesktopRequest({
            version: DESKTOP_PROTOCOL_VERSION,
            id: "owner-inherited-command",
            command,
          });
        } catch (error) {
          parseError = error;
        }
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(Object.prototype, field);
        } else {
          Object.defineProperty(Object.prototype, field, previous);
        }
      }

      expect(parseError).toEqual(new Error("invalid desktop request"));
    },
  );

  it("rejects request accessors without invoking them", () => {
    let envelopeReads = 0;
    const accessorEnvelope: Record<string, unknown> = {
      id: "owner-accessor-envelope",
      command: { kind: "read_owner_identity" },
    };
    Object.defineProperty(accessorEnvelope, "version", {
      enumerable: true,
      get: () => {
        envelopeReads += 1;
        return DESKTOP_PROTOCOL_VERSION;
      },
    });
    let commandReads = 0;
    const accessorCommand: Record<string, unknown> = {
      kind: "update_owner_identity",
      ownerUsername: "NewOwner",
    };
    Object.defineProperty(accessorCommand, "expectedRevision", {
      enumerable: true,
      get: () => {
        commandReads += 1;
        return 2;
      },
    });

    expect(() => parseDesktopRequest(accessorEnvelope)).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-accessor-command",
        command: accessorCommand,
      }),
    ).toThrow("invalid desktop request");
    expect(envelopeReads).toBe(0);
    expect(commandReads).toBe(0);
  });

  it("rejects non-enumerable substitutes and symbol fields at the request boundary", () => {
    const nonEnumerableEnvelope: Record<string, unknown> = {
      version: DESKTOP_PROTOCOL_VERSION,
      command: { kind: "read_owner_identity" },
    };
    Object.defineProperty(nonEnumerableEnvelope, "id", {
      enumerable: false,
      value: "owner-non-enumerable-envelope",
    });
    const nonEnumerableCommand: Record<string, unknown> = {
      kind: "update_owner_identity",
      expectedRevision: 2,
    };
    Object.defineProperty(nonEnumerableCommand, "ownerUsername", {
      enumerable: false,
      value: "NewOwner",
    });
    const privateField = Symbol("private");

    for (const request of [
      nonEnumerableEnvelope,
      {
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-non-enumerable-command",
        command: nonEnumerableCommand,
      },
      {
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-symbol-envelope",
        command: { kind: "read_owner_identity" },
        [privateField]: "secret",
      },
      {
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-symbol-command",
        command: { kind: "read_owner_identity", [privateField]: "secret" },
      },
    ]) {
      expect(() => parseDesktopRequest(request)).toThrow("invalid desktop request");
    }
  });

  it("maps both owner identity commands to one strict bounded snapshot", () => {
    const snapshot = {
      revision: 3,
      ownerUsername: "NewOwner",
      configured: true,
      presence: "unknown" as const,
    };
    expect(parseDesktopCommandResult({ kind: "read_owner_identity" }, snapshot)).toEqual(snapshot);
    expect(
      parseDesktopCommandResult(
        {
          kind: "update_owner_identity",
          expectedRevision: 2,
          ownerUsername: "NewOwner",
        },
        snapshot,
      ),
    ).toEqual(snapshot);

    for (const invalid of [
      { ...snapshot, revision: -1 },
      { ...snapshot, ownerUsername: "a".repeat(17) },
      { ...snapshot, ownerUsername: "YourMcName" },
      { ...snapshot, ownerUsername: null, configured: true },
      { ...snapshot, configured: false },
      { ...snapshot, presence: "away" },
      { ...snapshot, path: String.raw`C:\private\config.toml` },
      { ...snapshot, toml: "[minecraft]" },
      { ...snapshot, token: "secret" },
    ]) {
      expect(() => parseDesktopCommandResult({ kind: "read_owner_identity" }, invalid)).toThrow(
        "invalid desktop command result",
      );
    }
  });

  it("accepts only exact data-only owner identity events", () => {
    const event = {
      version: DESKTOP_PROTOCOL_VERSION,
      event: {
        kind: "owner_identity" as const,
        owner: {
          revision: 4,
          ownerUsername: "LiveOwner",
          configured: true,
          presence: "online" as const,
        },
      },
    };
    expect(parseDesktopEvent(event)).toEqual(event);

    const ownerGetter = {
      revision: 4,
      configured: true,
      presence: "online",
      get ownerUsername(): string {
        return "LiveOwner";
      },
    };
    const inheritedOwnerGetter = Object.assign(
      Object.create({
        get ownerUsername(): string {
          return "LiveOwner";
        },
      }) as Record<string, unknown>,
      {
        revision: 4,
        configured: true,
        presence: "online",
      },
    );
    for (const invalid of [
      { ...event, event: { ...event.event, extra: true } },
      { ...event, event: { ...event.event, owner: { ...event.event.owner, extra: true } } },
      { ...event, event: { ...event.event, owner: ownerGetter } },
      { ...event, event: { ...event.event, owner: inheritedOwnerGetter } },
      {
        ...event,
        event: {
          ...event.event,
          owner: { ...event.event.owner, path: String.raw`C:\private\config.toml` },
        },
      },
      {
        ...event,
        event: { ...event.event, owner: { ...event.event.owner, toml: "[minecraft]" } },
      },
      {
        ...event,
        event: { ...event.event, owner: { ...event.event.owner, token: "secret" } },
      },
      {
        ...event,
        event: { ...event.event, owner: { ...event.event.owner, ownerUsername: "a".repeat(17) } },
      },
      { ...event, event: { ...event.event, owner: { ...event.event.owner, revision: -1 } } },
      {
        ...event,
        event: { ...event.event, owner: { ...event.event.owner, presence: "invisible" } },
      },
    ]) {
      expect(() => parseDesktopEvent(invalid)).toThrow("invalid desktop event");
    }
  });

  it("rejects owner snapshots that inherit a required field from Object.prototype", () => {
    const inheritedValues = {
      revision: 4,
      ownerUsername: "LiveOwner",
      configured: true,
      presence: "online",
    } as const;
    for (const field of Object.keys(inheritedValues) as Array<keyof typeof inheritedValues>) {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
      const inheritedOwner: Record<string, unknown> = { ...inheritedValues };
      Reflect.deleteProperty(inheritedOwner, field);
      let eventError: unknown;
      let resultError: unknown;
      let responseError: unknown;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          get: () => inheritedValues[field],
        });
        try {
          parseDesktopEvent({
            version: DESKTOP_PROTOCOL_VERSION,
            event: { kind: "owner_identity", owner: inheritedOwner },
          });
        } catch (error) {
          eventError = error;
        }
        try {
          parseDesktopCommandResult({ kind: "read_owner_identity" }, inheritedOwner);
        } catch (error) {
          resultError = error;
        }
        try {
          parseDesktopResponse({
            version: DESKTOP_PROTOCOL_VERSION,
            id: "owner-inherited",
            ok: true,
            result: inheritedOwner,
          });
        } catch (error) {
          responseError = error;
        }
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(Object.prototype, field);
        } else {
          Object.defineProperty(Object.prototype, field, previous);
        }
      }

      expect(eventError).toEqual(new Error("invalid desktop event"));
      expect(resultError).toEqual(new Error("invalid desktop command result"));
      expect(responseError).toEqual(new Error("invalid desktop response"));
    }
  });

  it("rejects owner events that inherit a required envelope field from Object.prototype", () => {
    const inheritedValues = {
      version: DESKTOP_PROTOCOL_VERSION,
      event: {
        kind: "owner_identity",
        owner: {
          revision: 4,
          ownerUsername: "LiveOwner",
          configured: true,
          presence: "online",
        },
      },
      kind: "owner_identity",
      owner: {
        revision: 4,
        ownerUsername: "LiveOwner",
        configured: true,
        presence: "online",
      },
    } as const;
    for (const field of ["version", "event", "kind", "owner"] as const) {
      const envelope: Record<string, unknown> = {
        version: DESKTOP_PROTOCOL_VERSION,
        event: {
          kind: "owner_identity",
          owner: inheritedValues.owner,
        },
      };
      const target =
        field === "version" || field === "event"
          ? envelope
          : (envelope.event as Record<string, unknown>);
      Reflect.deleteProperty(target, field);
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let eventError: unknown;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          get: () => inheritedValues[field],
        });
        try {
          parseDesktopEvent(envelope);
        } catch (error) {
          eventError = error;
        }
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(Object.prototype, field);
        } else {
          Object.defineProperty(Object.prototype, field, previous);
        }
      }

      expect(eventError).toEqual(new Error("invalid desktop event"));
    }
  });

  it("accepts only bounded fixed owner identity protocol errors", () => {
    for (const error of [
      { code: "OWNER_IDENTITY_INVALID", message: "Owner identity is invalid" },
      { code: "OWNER_IDENTITY_REQUIRED", message: "Owner identity is required" },
      {
        code: "OWNER_IDENTITY_CONFIG_CONFLICT",
        message: "Owner identity configuration changed",
      },
      { code: "OWNER_IDENTITY_WRITE_FAILED", message: "Owner identity update failed" },
      {
        code: "OWNER_IDENTITY_CONFIG_INVALID",
        message: "Owner identity configuration is invalid",
      },
    ] as const) {
      expect(
        parseDesktopResponse({
          version: DESKTOP_PROTOCOL_VERSION,
          id: "owner-error",
          ok: false,
          error,
        }),
      ).toMatchObject({ ok: false, error });
    }
    expect(() =>
      parseDesktopResponse({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "owner-error-secret",
        ok: false,
        error: {
          code: "OWNER_IDENTITY_WRITE_FAILED",
          message: String.raw`Owner PrivateOwner failed at C:\private\config.toml`,
        },
      }),
    ).toThrow("invalid desktop response");
  });

  it("accepts only opaque capability-shaped diagnostic commands and strict path-free results", () => {
    const previewCommand = { kind: "preview_diagnostics" as const };
    const archiveCommand = {
      kind: "prepare_diagnostic_archive" as const,
      exportId: "diagnostic_1234567890",
    };
    expect(
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "diagnostic-preview",
        command: previewCommand,
      }),
    ).toMatchObject({ command: previewCommand });
    expect(
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "diagnostic-export",
        command: archiveCommand,
      }),
    ).toMatchObject({ command: archiveCommand });
    expect(() =>
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "diagnostic-forged-path",
        command: {
          ...archiveCommand,
          destination: String.raw`C:\renderer-controlled.zip`,
        },
      }),
    ).toThrow("invalid desktop request");

    const preview = {
      exportId: "diagnostic_1234567890",
      files: [
        { logicalName: "app-version.json", size: 20, redactions: 0 },
        { logicalName: "os-summary.json", size: 20, redactions: 0 },
        { logicalName: "dependency-versions.json", size: 20, redactions: 0 },
        { logicalName: "minecraft-compatibility.json", size: 20, redactions: 0 },
        { logicalName: "app-log.jsonl", size: 20, redactions: 0 },
        { logicalName: "audit-log.jsonl", size: 20, redactions: 0 },
        { logicalName: "config-schema-summary.json", size: 20, redactions: 0 },
      ],
      omitted: [
        "minecraft-saves",
        "authentication-data",
        "pcl2-account-data",
        "complete-companion-profile",
        "complete-memories",
        "raw-chat",
      ],
    };
    expect(parseDesktopCommandResult(previewCommand, preview)).toEqual(preview);
    expect(() =>
      parseDesktopCommandResult(previewCommand, {
        exportId: preview.exportId,
        files: [],
        omitted: [],
      }),
    ).toThrow("invalid desktop command result");
    expect(
      parseDesktopCommandResult(archiveCommand, {
        exportId: archiveCommand.exportId,
        size: 512,
        sha256: "a".repeat(64),
      }),
    ).toEqual({ exportId: archiveCommand.exportId, size: 512, sha256: "a".repeat(64) });
    expect(() =>
      parseDesktopCommandResult(archiveCommand, {
        exportId: archiveCommand.exportId,
        size: 512,
        sha256: "a".repeat(64),
        path: String.raw`C:\private\diagnostics.zip`,
      }),
    ).toThrow("invalid desktop command result");
  });
  it("accepts only strict revision-checked bound-world commands", () => {
    const bind = {
      kind: "bind_confirmed_world" as const,
      expectedRevision: 0,
      label: "Survival",
    };
    expect(parseDesktopRequest({ version: 1, id: "bind-world", command: bind })).toMatchObject({
      command: bind,
    });
    expect(
      parseDesktopRequest({
        version: 1,
        id: "update-safety",
        command: { kind: "update_safety_profile", expectedRevision: 1, safetyPreset: "standard" },
      }),
    ).toMatchObject({ command: { kind: "update_safety_profile", safetyPreset: "standard" } });
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "world-extra",
        command: { ...bind, canonicalInstancePath: "C:/renderer-controlled" },
      }),
    ).toThrow("invalid desktop request");
  });
  it("does not expose parent-derived world authority to the public command parser", () => {
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "forged-world-authority",
        command: {
          kind: "set_confirmed_world_authority",
          binding: {
            canonicalInstancePath: "C:/renderer-controlled",
            javaSession: { pid: 1234, processStartedAt: 1, port: 25565, version: "1.21.5" },
            ownerUsername: "Owner",
            proof: {
              nonce: "renderer_forged_nonce_0001",
              port: 25565,
              issuedAt: 1,
              expiresAt: 2,
            },
          },
        },
      }),
    ).toThrow("invalid desktop request");
  });
  it("requires observed document revisions for strict memory mutations", () => {
    const add = {
      kind: "add_memory" as const,
      expectedRevision: 0,
      memory: {
        category: "project" as const,
        summary: "oak tower",
        importance: 3 as const,
        scope: "global" as const,
      },
    };
    expect(parseDesktopRequest({ version: 1, id: "memory-add", command: add })).toMatchObject({
      command: add,
    });
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "memory-stale",
        command: { ...add, expectedRevision: -1 },
      }),
    ).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "memory-extra",
        command: { ...add, recordRevision: 0 },
      }),
    ).toThrow("invalid desktop request");
  });

  it("parses the narrow memory read, search, export, and mutation command surface", () => {
    const commands = [
      { kind: "read_memories" as const },
      {
        kind: "search_memories" as const,
        query: "oak tower",
        scope: { mode: "world" as const, worldId: "overworld" },
      },
      { kind: "export_memories" as const },
      {
        kind: "add_memory" as const,
        expectedRevision: 0,
        memory: {
          category: "project" as const,
          summary: "oak tower",
          importance: 3 as const,
          scope: "world" as const,
        },
      },
      {
        kind: "update_memory" as const,
        id: 1,
        expectedRevision: 1,
        recordRevision: 1,
        patch: { summary: "oak tower v2" },
      },
      { kind: "forget_memory" as const, id: 1, expectedRevision: 1, recordRevision: 1 },
      {
        kind: "pin_memory" as const,
        id: 1,
        expectedRevision: 1,
        recordRevision: 1,
        pinned: false,
      },
    ];

    for (const [index, command] of commands.entries()) {
      expect(parseDesktopRequest({ version: 1, id: `memory-${index}`, command })).toEqual({
        version: 1,
        id: `memory-${index}`,
        command,
      });
    }
    for (const command of [
      {
        kind: "add_memory",
        expectedRevision: 0,
        memory: {
          category: "project",
          summary: "forged world",
          importance: 3,
          scope: "world",
          worldId: "renderer-forged",
        },
      },
      {
        kind: "update_memory",
        id: 1,
        expectedRevision: 1,
        recordRevision: 1,
        patch: { scope: "world", worldId: "renderer-forged" },
      },
    ]) {
      expect(() =>
        parseDesktopRequest({
          version: DESKTOP_PROTOCOL_VERSION,
          id: "forged-memory-world",
          command,
        }),
      ).toThrow("invalid desktop request");
    }
  });

  it("parses a dedicated redacted export command and rejects ordinary memory envelopes as its result", () => {
    const command = { kind: "export_redacted_memories" as const };
    expect(
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "memory-redacted-export",
        command,
      }),
    ).toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "memory-redacted-export",
      command,
    });
    const result = {
      schemaVersion: 1 as const,
      revision: 4,
      updatedAt: "2026-07-29T00:00:00.000Z",
      legacyMigrated: true,
      records: [
        {
          id: 1,
          category: "project" as const,
          summary: "[REDACTED_PATH]",
          importance: 3 as const,
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
          scope: "global" as const,
          source: "manual" as const,
          pinned: false,
          revision: 0,
        },
      ],
    };
    expect(parseDesktopCommandResult(command, result)).toEqual(result);
    expect(() =>
      parseDesktopCommandResult(command, {
        ...result,
        records: [{ ...result.records[0], worldId: "unexpected" }],
      }),
    ).toThrow("invalid desktop command result");
  });
  it("round-trips only strict bounded memory-scope requests", () => {
    const request = {
      version: DESKTOP_PROTOCOL_VERSION,
      id: "memory-scope-1",
      command: {
        kind: "set_memory_scope" as const,
        scope: { mode: "world" as const, worldId: "world-a" },
      },
    };
    expect(parseDesktopRequest(request)).toEqual(request);
    expect(parseDesktopCommandResult(request.command, idleSnapshot)).toEqual(idleSnapshot);
    expect(() =>
      parseDesktopRequest({
        ...request,
        command: {
          kind: "set_memory_scope",
          scope: { mode: "world", worldId: "world-a", extra: true },
        },
      }),
    ).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        ...request,
        command: { kind: "set_memory_scope", scope: { mode: "world" } },
      }),
    ).toThrow("invalid desktop request");
  });

  it("round-trips strict opaque memory migration commands and correlated results", () => {
    const preview = { kind: "preview_memory_migration" as const, scope: "world" as const };
    const commit = {
      kind: "commit_memory_migration" as const,
      migrationId: "migration_opaque_1234",
      sourceRevision: 7,
    };
    const rollback = {
      kind: "rollback_memory_migration" as const,
      migrationId: "migration_opaque_1234",
    };
    for (const [index, command] of [preview, commit, rollback].entries()) {
      expect(
        parseDesktopRequest({
          version: DESKTOP_PROTOCOL_VERSION,
          id: `migration-${index}`,
          command,
        }),
      ).toMatchObject({ command });
    }
    expect(
      parseDesktopCommandResult(preview, {
        migrationId: "migration_opaque_1234",
        sourceRevision: 7,
        targetScope: "world",
        deduplicatedCount: 2,
        movedCount: 3,
      }),
    ).toEqual({
      migrationId: "migration_opaque_1234",
      sourceRevision: 7,
      targetScope: "world",
      deduplicatedCount: 2,
      movedCount: 3,
    });
    expect(
      parseDesktopCommandResult(commit, {
        migrationId: "migration_opaque_1234",
        status: "committed",
      }),
    ).toEqual({ migrationId: "migration_opaque_1234", status: "committed" });
    expect(
      parseDesktopCommandResult(rollback, {
        migrationId: "migration_opaque_1234",
        status: "rolled_back",
      }),
    ).toEqual({ migrationId: "migration_opaque_1234", status: "rolled_back" });
    expect(() =>
      parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "migration-extra",
        command: { ...preview, worldId: "renderer-controlled" },
      }),
    ).toThrow("invalid desktop request");
  });

  it("round-trips exact bounded profile read, update, and behavior-mode commands", () => {
    const profile = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const commands = [
      { kind: "read_profile" as const },
      { kind: "update_profile" as const, expectedRevision: 4, profile },
      {
        kind: "set_behavior_mode" as const,
        expectedRevision: 5,
        mode: "balanced" as const,
        settings: profile.modeSettings.balanced,
      },
    ];

    for (const [index, command] of commands.entries()) {
      expect(
        parseDesktopRequest({
          version: 1,
          id: `profile-${index}`,
          command,
        }),
      ).toEqual({ version: 1, id: `profile-${index}`, command });
    }
    const envelope = {
      schemaVersion: 1,
      revision: 6,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: profile,
    };
    expect(parseDesktopCommandResult(commands[0]!, envelope)).toEqual(envelope);
    for (const command of commands.slice(1)) {
      const result = { envelope, liveStatus: "applied" as const };
      expect(parseDesktopCommandResult(command, result)).toEqual(result);
    }
  });

  it("rejects unsafe profile revisions and over-bound or unknown profile payloads", () => {
    const profile = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseDesktopRequest({
          version: 1,
          id: "profile-revision",
          command: { kind: "update_profile", expectedRevision, profile },
        }),
      ).toThrow("invalid desktop request");
    }
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "profile-extra",
        command: {
          kind: "update_profile",
          expectedRevision: 0,
          profile: { ...profile, persona: "x".repeat(4_001), apiKey: "secret" },
        },
      }),
    ).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "profile-mode-extra",
        command: {
          kind: "set_behavior_mode",
          expectedRevision: 0,
          mode: "friend",
          settings: { ...profile.modeSettings.friend, worldMutation: true },
        },
      }),
    ).toThrow("invalid desktop request");
  });

  it("rejects malformed or oversized profile command results", () => {
    const command = { kind: "read_profile" as const };
    const profile = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    for (const result of [
      {
        schemaVersion: 1,
        revision: Number.MAX_SAFE_INTEGER + 1,
        updatedAt: "2026-07-29T01:02:03.004Z",
        value: profile,
      },
      {
        schemaVersion: 1,
        revision: 0,
        updatedAt: "not-a-timestamp",
        value: profile,
      },
      {
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-07-29T01:02:03.004Z",
        value: { ...profile, persona: "x".repeat(4_001) },
      },
    ]) {
      expect(() => parseDesktopCommandResult(command, result)).toThrow(
        "invalid desktop command result",
      );
    }
  });

  it("accepts stable public profile conflict and generic operation failures", () => {
    for (const error of [
      { code: "DOCUMENT_CONFLICT", message: "Profile revision conflict" },
      { code: "PROFILE_OPERATION_FAILED", message: "Profile operation failed" },
    ] as const) {
      expect(
        parseDesktopResponse({
          version: 1,
          id: "profile-error",
          ok: false,
          error,
        }),
      ).toMatchObject({ ok: false, error });
    }
  });

  it("round-trips committed profile containment status and failure evidence", () => {
    const profile = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const envelope = {
      schemaVersion: 1 as const,
      revision: 7,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: profile,
    };
    const command = { kind: "update_profile" as const, expectedRevision: 6, profile };

    expect(
      parseDesktopCommandResult(command, {
        envelope,
        liveStatus: "runtime_contained",
      }),
    ).toEqual({ envelope, liveStatus: "runtime_contained" });
    expect(
      parseDesktopResponse({
        version: 1,
        id: "profile-contained-error",
        ok: false,
        error: {
          code: "PROFILE_RUNTIME_CONTAINMENT_FAILED",
          message: "Profile committed but runtime containment failed",
          committed: envelope,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "PROFILE_RUNTIME_CONTAINMENT_FAILED", committed: envelope },
    });
    expect(() =>
      parseDesktopCommandResult(command, { envelope, liveStatus: "stale_runtime" }),
    ).toThrow("invalid desktop command result");
  });

  it("accepts only the ten exact bounded command objects", () => {
    for (const kind of [
      "get_status",
      "start_runtime",
      "stop_runtime",
      "emergency_stop",
      "get_account",
      "start_chatgpt_login",
      "list_models",
    ] as const) {
      expect(
        parseDesktopRequest({
          version: 1,
          id: `req-${kind}`,
          command: { kind },
        }),
      ).toEqual({
        version: 1,
        id: `req-${kind}`,
        command: { kind },
      });
    }
    expect(
      parseDesktopRequest({
        version: 1,
        id: "req-cancel",
        command: { kind: "cancel_chatgpt_login", attemptId: "opaque_attempt_1234" },
      }),
    ).toMatchObject({ command: { kind: "cancel_chatgpt_login" } });
    expect(
      parseDesktopRequest({
        version: 1,
        id: "req-model",
        command: {
          kind: "select_model",
          selection: {
            mode: "explicit",
            modelId: "live-model",
            reasoningEffort: "xhigh",
          },
        },
      }),
    ).toMatchObject({ command: { kind: "select_model" } });
    expect(
      parseDesktopRequest({
        version: 1,
        id: "req-connection",
        command: {
          kind: "set_confirmed_connection",
          proof: {
            nonce: "proof_nonce_12345678",
            port: 51321,
            issuedAt: 1_000,
            expiresAt: 11_000,
          },
        },
      }),
    ).toMatchObject({
      command: {
        kind: "set_confirmed_connection",
        proof: { nonce: "proof_nonce_12345678", port: 51321 },
      },
    });

    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "req-2",
        command: { kind: "run_shell", text: "whoami" },
      }),
    ).toThrow("invalid desktop request");
    for (const forbidden of [
      { host: "127.0.0.1" },
      { pid: 4200 },
      { processStartedAt: 1785196800123 },
      { script: "Get-NetTCPConnection" },
      { executable: "powershell.exe" },
    ]) {
      expect(() =>
        parseDesktopRequest({
          version: 1,
          id: "req-connection-forbidden",
          command: {
            kind: "set_confirmed_connection",
            proof: {
              nonce: "proof_nonce_12345678",
              port: 51321,
              issuedAt: 1_000,
              expiresAt: 11_000,
              ...forbidden,
            },
          },
        }),
      ).toThrow("invalid desktop request");
    }
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "req-3",
        command: { kind: "stop_runtime", reason: "process_exit" },
      }),
    ).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "req-url",
        command: {
          kind: "start_chatgpt_login",
          url: "https://evil.test/?token=secret",
        },
      }),
    ).toThrow("invalid desktop request");
  });

  it("enforces exact request envelopes and bounded safe ASCII IDs", () => {
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "req-1",
        command: { kind: "get_status" },
        executable: "cmd.exe",
      }),
    ).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "../private",
        command: { kind: "get_status" },
      }),
    ).toThrow("invalid desktop request");
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "a".repeat(65),
        command: { kind: "get_status" },
      }),
    ).toThrow("invalid desktop request");
  });

  it("parses exact success and bounded error response envelopes", () => {
    expect(
      parseDesktopResponse({
        version: 1,
        id: "req-1",
        ok: true,
        result: idleSnapshot,
      }),
    ).toEqual({
      version: 1,
      id: "req-1",
      ok: true,
      result: idleSnapshot,
    });
    expect(
      parseDesktopResponse({
        version: 1,
        id: "req-2",
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Invalid desktop request" },
      }),
    ).toMatchObject({
      id: "req-2",
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });

    expect(() =>
      parseDesktopResponse({
        version: 1,
        id: "req-3",
        ok: true,
        result: {
          ...idleSnapshot,
          minecraft: { ...idleSnapshot.minecraft, privatePath: "C:\\private" },
        },
      }),
    ).toThrow("invalid desktop response");
  });

  it("parses exact runtime event envelopes", () => {
    expect(
      parseDesktopEvent({
        version: 1,
        event: { kind: "lifecycle", revision: 7, state: "running" },
      }),
    ).toEqual({
      version: 1,
      event: { kind: "lifecycle", revision: 7, state: "running" },
    });

    expect(() =>
      parseDesktopEvent({
        version: 1,
        event: {
          kind: "lifecycle",
          revision: 7,
          state: "running",
          path: "C:\\private",
        },
      }),
    ).toThrow("invalid desktop event");
    expect(() =>
      parseDesktopEvent({
        version: 1,
        event: { kind: "lifecycle", state: "running" },
      }),
    ).toThrow("invalid desktop event");
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseDesktopEvent({
          version: 1,
          event: { kind: "lifecycle", revision, state: "running" },
        }),
      ).toThrow("invalid desktop event");
    }
  });

  it("parses only an exact restart-safe connection invalidation signal", () => {
    const signal = {
      kind: "connection_invalidated",
      revision: 8,
      reason: "account_lost",
      snapshot: { ...idleSnapshot, revision: 8, lifecycle: "stopped" },
    } as const;
    expect(
      parseDesktopEvent({
        version: DESKTOP_PROTOCOL_VERSION,
        event: signal,
      }),
    ).toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      event: signal,
    });
    expect(() =>
      parseDesktopEvent({
        version: DESKTOP_PROTOCOL_VERSION,
        event: { ...signal, snapshot: { ...signal.snapshot, revision: 7 } },
      }),
    ).toThrow("invalid desktop event");
    expect(() =>
      parseDesktopEvent({
        version: DESKTOP_PROTOCOL_VERSION,
        event: { ...signal, reason: "renderer_requested" },
      }),
    ).toThrow("invalid desktop event");
    for (const unsafeSnapshot of [
      { ...signal.snapshot, lifecycle: "running" },
      {
        ...signal.snapshot,
        minecraft: { state: "connected", sessionId: "private-session" },
      },
      { ...signal.snapshot, minecraft: { state: "disconnected", sessionId: "stale-session" } },
      { ...signal.snapshot, codex: { state: "ready", model: "stale-model" } },
      { ...signal.snapshot, codex: { state: "stopped", model: "stale-model" } },
      {
        ...signal.snapshot,
        task: {
          id: "public-task",
          disclosure: {
            goal: "unsafe",
            expectedActions: ["move"],
            limits: {
              maxToolCalls: 1,
              maxBlockChanges: 1,
              maxHorizontalTravel: 1,
              maxDurationMs: 1,
              maxDangerousOperations: 0,
            },
            stopCondition: "never",
          },
          startedAt: "2026-07-28T00:00:00.000Z",
          budget: {
            active: true,
            stopReason: null,
            limits: {
              maxToolCalls: 1,
              maxBlockChanges: 1,
              maxHorizontalTravel: 1,
              maxDurationMs: 1,
              maxDangerousOperations: 0,
            },
            toolCalls: 0,
            blockChanges: 0,
            horizontalTravel: 0,
            dangerousOperations: 0,
            startedAt: 1,
          },
        },
      },
    ]) {
      expect(() =>
        parseDesktopEvent({
          version: DESKTOP_PROTOCOL_VERSION,
          event: { ...signal, snapshot: unsafeSnapshot },
        }),
      ).toThrow("invalid desktop event");
    }
  });

  it("requires a bounded safe-integer revision on every runtime snapshot", () => {
    expect(parseDesktopCommandResult({ kind: "get_status" }, idleSnapshot)).toEqual(idleSnapshot);
    const { revision: _revision, ...missingRevision } = idleSnapshot;
    expect(() => parseDesktopCommandResult({ kind: "get_status" }, missingRevision)).toThrow(
      "invalid desktop command result",
    );
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseDesktopCommandResult({ kind: "get_status" }, { ...idleSnapshot, revision }),
      ).toThrow("invalid desktop command result");
    }
  });

  it("accepts only the explicit lease-free public task projection", () => {
    const limits = {
      maxToolCalls: 8,
      maxBlockChanges: 12,
      maxHorizontalTravel: 64,
      maxDurationMs: 120_000,
      maxDangerousOperations: 1,
    };
    const budget = {
      active: true,
      stopReason: null,
      limits,
      toolCalls: 2,
      blockChanges: 1,
      horizontalTravel: 4,
      dangerousOperations: 0,
      startedAt: 1_785_369_600_000,
    };
    const task = {
      id: "task_public_123",
      goal: "走到主人身边",
      status: "running",
      allowedActions: ["get_state", "move_to"],
      effectiveLimits: limits,
      startedAt: "2026-07-30T00:00:00.000Z",
      budget,
    } as const;
    const snapshot = { ...idleSnapshot, revision: 7, lifecycle: "running", task } as const;

    expect(parseDesktopCommandResult({ kind: "get_status" }, snapshot)).toEqual(snapshot);
    const modelChangedSnapshot = {
      ...snapshot,
      task: {
        ...task,
        budget: { ...budget, active: false, stopReason: "model_changed", startedAt: null },
      },
    } as const;
    expect(parseDesktopCommandResult({ kind: "get_status" }, modelChangedSnapshot)).toEqual(
      modelChangedSnapshot,
    );
    expect(JSON.stringify(snapshot.task)).not.toContain("lease");
    expect(JSON.stringify(snapshot.task)).not.toContain("ownerUsername");
    expect(JSON.stringify(snapshot.task)).not.toContain("prompt");

    const accessorTask = { ...task } as Record<string, unknown>;
    let accessorReads = 0;
    Object.defineProperty(accessorTask, "goal", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return task.goal;
      },
    });
    for (const invalidTask of [
      { ...task, lease: { id: "lease-secret", startedAt: budget.startedAt } },
      {
        id: task.id,
        disclosure: {
          goal: task.goal,
          expectedActions: task.allowedActions,
          limits,
          stopCondition: "secret prompt",
        },
        startedAt: task.startedAt,
        budget,
      },
      { ...task, status: "paused" },
      { ...task, id: "task_Public_123" },
      { ...task, id: "public_task_123" },
      { ...task, id: "task_" },
      { ...task, effectiveLimits: { ...limits, maxToolCalls: Number.POSITIVE_INFINITY } },
      { ...task, goal: "x".repeat(32_001) },
      accessorTask,
    ]) {
      expect(() =>
        parseDesktopCommandResult({ kind: "get_status" }, { ...snapshot, task: invalidTask }),
      ).toThrow("invalid desktop command result");
    }
    expect(accessorReads).toBe(0);
  });

  it("accepts only an exact task-stop command and maps it to a runtime snapshot", () => {
    const request = {
      version: DESKTOP_PROTOCOL_VERSION,
      id: "stop-task",
      command: { kind: "stop_task" },
    } as const;

    expect(parseDesktopRequest(request)).toEqual(request);
    expect(parseDesktopCommandResult(request.command, idleSnapshot)).toEqual(idleSnapshot);
    for (const command of [
      { kind: "stop_task", reason: "owner_stop" },
      { kind: "stop_task", prompt: "secret" },
    ]) {
      expect(() => parseDesktopRequest({ ...request, command })).toThrow("invalid desktop request");
    }
  });

  it("maps every command to one strict result shape", () => {
    expect(parseDesktopCommandResult({ kind: "get_status" }, idleSnapshot)).toEqual(idleSnapshot);
    expect(
      parseDesktopCommandResult({ kind: "get_account" }, { status: "signed_in", auth: "chatgpt" }),
    ).toEqual({ status: "signed_in", auth: "chatgpt" });
    expect(
      parseDesktopCommandResult(
        { kind: "start_chatgpt_login" },
        {
          attempt: {
            status: "pending",
            attemptId: "opaque_attempt_1234",
            expiresAt: 123_456,
          },
          loginUrl: "https://auth.openai.com/oauth?state=private",
        },
      ),
    ).toMatchObject({ attempt: { status: "pending" } });
    expect(
      parseDesktopCommandResult(
        { kind: "list_models" },
        {
          models: [
            {
              id: "live-model",
              displayName: "Live Model",
              supportedReasoningEfforts: ["medium", "high"],
            },
          ],
          selection: { mode: "automatic" },
          legacyMigrationCompleted: true,
        },
      ),
    ).toMatchObject({
      models: [{ id: "live-model" }],
      legacyMigrationCompleted: true,
    });
    expect(() =>
      parseDesktopCommandResult(
        { kind: "list_models" },
        {
          models: [],
          selection: { mode: "automatic" },
        },
      ),
    ).toThrow("invalid desktop command result");
    expect(
      parseDesktopCommandResult(
        {
          kind: "select_model",
          selection: { mode: "automatic" },
        },
        { mode: "automatic" },
      ),
    ).toEqual({ mode: "automatic" });
    expect(
      parseDesktopCommandResult(
        {
          kind: "set_confirmed_connection",
          proof: {
            nonce: "proof_nonce_12345678",
            port: 51321,
            issuedAt: 1_000,
            expiresAt: 11_000,
          },
        },
        { status: "configured", port: 51321, confirmedAt: 1_000 },
      ),
    ).toEqual({ status: "configured", port: 51321, confirmedAt: 1_000 });
    expect(() =>
      parseDesktopCommandResult(
        {
          kind: "set_confirmed_connection",
          proof: {
            nonce: "proof_nonce_12345678",
            port: 51321,
            issuedAt: 1_000,
            expiresAt: 11_000,
          },
        },
        {
          status: "configured",
          port: 51321,
          confirmedAt: 1_000,
          proof: "proof_nonce_12345678",
        },
      ),
    ).toThrow("invalid desktop command result");

    expect(() =>
      parseDesktopCommandResult(
        { kind: "get_account" },
        { ...idleSnapshot, loginUrl: "https://auth.openai.com/?secret=value" },
      ),
    ).toThrow("invalid desktop command result");
    expect(() =>
      parseDesktopCommandResult({ kind: "get_status" }, { status: "signed_out" }),
    ).toThrow("invalid desktop command result");
  });

  it("accepts account state events without ever including the login URL", () => {
    expect(
      parseDesktopEvent({
        version: 1,
        event: {
          kind: "account",
          account: {
            status: "pending",
            attemptId: "opaque_attempt_1234",
            expiresAt: 123_456,
          },
        },
      }),
    ).toMatchObject({ event: { kind: "account" } });
    expect(() =>
      parseDesktopEvent({
        version: 1,
        event: {
          kind: "account",
          account: {
            status: "pending",
            attemptId: "opaque_attempt_1234",
            expiresAt: 123_456,
            loginUrl: "https://auth.openai.com/?token=secret",
          },
        },
      }),
    ).toThrow("invalid desktop event");
  });

  it("publishes the fixed protocol and line-boundary constants", () => {
    expect(DESKTOP_PROTOCOL_VERSION).toBe(1);
    expect(MAX_DESKTOP_LINE_BYTES).toBe(1_048_576);
  });
});
