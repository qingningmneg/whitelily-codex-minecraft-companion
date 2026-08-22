import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WindowsReparseProbeAuthority } from "./windowsReparseProbe.js";

interface FakeProbeControl {
  respond(...chunks: readonly string[]): void;
  close(): void;
  error(): void;
}

type FakeProbeScenario = (request: string, control: FakeProbeControl, requestIndex: number) => void;

interface FakeProbeTracking {
  starts: number;
  closes: number;
}

function fakeSpawnSequence(
  scenarios: readonly FakeProbeScenario[],
  tracking: FakeProbeTracking,
): typeof nodeSpawn {
  let spawnIndex = 0;
  return (() => {
    const scenario = scenarios[spawnIndex++];
    if (scenario === undefined) throw new Error("unexpected probe restart");
    tracking.starts += 1;
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    let input = "";
    let requestIndex = 0;
    let closed = false;
    let killed = false;
    let exitCode: number | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      exitCode = 1;
      tracking.closes += 1;
      emitter.emit("close", 1, null);
    };
    const control: FakeProbeControl = {
      respond: (...chunks) => {
        for (const chunk of chunks) stdout.write(chunk);
      },
      close,
      error: () => emitter.emit("error", new Error("forced helper error")),
    };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        input += chunk.toString("utf8");
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline < 0) break;
          const request = input.slice(0, newline);
          input = input.slice(newline + 1);
          scenario(request, control, requestIndex++);
        }
        callback();
      },
    });
    const child = emitter as unknown as ReturnType<typeof nodeSpawn>;
    Object.assign(child, {
      stdin,
      stdout,
      stderr: null,
      stdio: [stdin, stdout, null],
      unref: () => child,
      ref: () => child,
      kill: () => {
        killed = true;
        queueMicrotask(close);
        return true;
      },
    });
    Object.defineProperties(child, {
      killed: { get: () => killed },
      exitCode: { get: () => exitCode },
    });
    return child;
  }) as typeof nodeSpawn;
}

async function ordinaryDirectory(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-reparse-protocol-"));
  return { root, path: root };
}

it.skipIf(process.platform !== "win32")(
  "reuses one bounded reparse helper and terminates it after the idle window",
  async () => {
    let starts = 0;
    let closes = 0;
    const spawnProcess = ((...args: Parameters<typeof nodeSpawn>) => {
      const child = nodeSpawn(...args);
      starts += 1;
      child.once("close", () => {
        closes += 1;
      });
      return child;
    }) as typeof nodeSpawn;
    const authority = new WindowsReparseProbeAuthority({ spawnProcess });
    const root = await mkdtemp(join(tmpdir(), "whitelily-reparse-reuse-"));
    try {
      await authority.assertPathsAreOrdinary([root]);
      await authority.assertPathsAreOrdinary([root]);
      expect(starts).toBe(1);
      await expect.poll(() => closes, { timeout: 3_000 }).toBe(1);
    } finally {
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "serializes concurrent requests through one helper",
  async () => {
    const tracking = { starts: 0, closes: 0 };
    let busy = false;
    const authority = new WindowsReparseProbeAuthority({
      spawnProcess: fakeSpawnSequence(
        [
          (_request, control) => {
            if (busy) {
              control.respond("ERR\n");
              return;
            }
            busy = true;
            setTimeout(() => {
              busy = false;
              control.respond("OK\n");
            }, 5);
          },
        ],
        tracking,
      ),
    });
    const fixture = await ordinaryDirectory();
    try {
      await Promise.all([
        authority.assertPathsAreOrdinary([fixture.path]),
        authority.assertPathsAreOrdinary([fixture.path]),
      ]);
      expect(tracking.starts).toBe(1);
    } finally {
      authority.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
    await expect.poll(() => tracking.closes).toBe(1);
  },
);

it.skipIf(process.platform !== "win32")(
  "accepts one valid response split across stdout chunks",
  async () => {
    const tracking = { starts: 0, closes: 0 };
    const authority = new WindowsReparseProbeAuthority({
      spawnProcess: fakeSpawnSequence(
        [
          (_request, control) => {
            control.respond("O");
            queueMicrotask(() => control.respond("K\n"));
          },
        ],
        tracking,
      ),
    });
    const fixture = await ordinaryDirectory();
    try {
      await expect(authority.assertPathsAreOrdinary([fixture.path])).resolves.toBeUndefined();
    } finally {
      authority.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
    await expect.poll(() => tracking.closes).toBe(1);
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects coalesced stale frames and restarts cleanly for the next request",
  async () => {
    const tracking = { starts: 0, closes: 0 };
    const authority = new WindowsReparseProbeAuthority({
      spawnProcess: fakeSpawnSequence(
        [
          (_request, control) => control.respond("OK\nERR\n"),
          (_request, control) => control.respond("OK\n"),
        ],
        tracking,
      ),
    });
    const fixture = await ordinaryDirectory();
    try {
      await expect(authority.assertPathsAreOrdinary([fixture.path])).rejects.toThrow(
        "Windows reparse boundary invalid",
      );
      await expect(authority.assertPathsAreOrdinary([fixture.path])).resolves.toBeUndefined();
      expect(tracking.starts).toBe(2);
    } finally {
      authority.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
    await expect.poll(() => tracking.closes).toBe(2);
  },
);

it.skipIf(process.platform !== "win32").each([
  ["oversized", "123456789"],
  ["invalid", "MAYBE\n"],
])("rejects %s helper output", async (_label, response) => {
  const tracking = { starts: 0, closes: 0 };
  const authority = new WindowsReparseProbeAuthority({
    spawnProcess: fakeSpawnSequence([(_request, control) => control.respond(response)], tracking),
  });
  const fixture = await ordinaryDirectory();
  try {
    await expect(authority.assertPathsAreOrdinary([fixture.path])).rejects.toThrow(
      "Windows reparse boundary invalid",
    );
  } finally {
    authority.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  await expect.poll(() => tracking.closes).toBe(1);
});

it.skipIf(process.platform !== "win32")(
  "rejects and cleans up a pending request timeout",
  async () => {
    vi.useFakeTimers();
    const tracking = { starts: 0, closes: 0 };
    const authority = new WindowsReparseProbeAuthority({
      spawnProcess: fakeSpawnSequence([() => undefined], tracking),
    });
    const fixture = await ordinaryDirectory();
    try {
      const pending = authority.assertPathsAreOrdinary([fixture.path]);
      const rejected = expect(pending).rejects.toThrow("Windows reparse boundary invalid");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
    } finally {
      authority.close();
      vi.useRealTimers();
      await rm(fixture.root, { recursive: true, force: true });
    }
    await expect.poll(() => tracking.closes).toBe(1);
  },
);

it.skipIf(process.platform !== "win32").each(["error", "close"] as const)(
  "rejects a pending request on helper %s",
  async (failure) => {
    const tracking = { starts: 0, closes: 0 };
    const authority = new WindowsReparseProbeAuthority({
      spawnProcess: fakeSpawnSequence(
        [(_request, control) => queueMicrotask(() => control[failure]())],
        tracking,
      ),
    });
    const fixture = await ordinaryDirectory();
    try {
      await expect(authority.assertPathsAreOrdinary([fixture.path])).rejects.toThrow(
        "Windows reparse boundary invalid",
      );
    } finally {
      authority.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
    await expect.poll(() => tracking.closes).toBe(1);
  },
);

it.skipIf(process.platform !== "win32")(
  "restarts successfully after an unexpected helper close",
  async () => {
    const tracking = { starts: 0, closes: 0 };
    const authority = new WindowsReparseProbeAuthority({
      spawnProcess: fakeSpawnSequence(
        [
          (_request, control) => queueMicrotask(() => control.close()),
          (_request, control) => control.respond("OK\n"),
        ],
        tracking,
      ),
    });
    const fixture = await ordinaryDirectory();
    try {
      await expect(authority.assertPathsAreOrdinary([fixture.path])).rejects.toThrow(
        "Windows reparse boundary invalid",
      );
      await expect(authority.assertPathsAreOrdinary([fixture.path])).resolves.toBeUndefined();
      expect(tracking.starts).toBe(2);
    } finally {
      authority.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
    await expect.poll(() => tracking.closes).toBe(2);
  },
);
