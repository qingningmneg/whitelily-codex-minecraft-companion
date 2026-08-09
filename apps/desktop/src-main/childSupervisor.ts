import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
  DESKTOP_PROTOCOL_VERSION,
  isAuthorityFreeTerminalRuntimeSnapshot,
  MAX_DESKTOP_LINE_BYTES,
  parseDesktopCommandResult,
  parseDesktopEvent,
  parseDesktopRequest,
  parseDesktopResponse,
  type DesktopCommand,
  type DesktopCommandResult,
  type ConnectionInvalidatedEvent,
  type DesktopEvent,
  type DesktopRequest,
} from "../../../src/desktop/desktopProtocol.js";
import { parsePrivateChildRequest } from "../../../src/desktop/privateChildProtocol.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import type { CompanionProfile } from "../../../src/profile/profileSchema.js";
import type { DocumentEnvelope } from "../../../src/storage/documentStore.js";
import type { ConfirmedWorldBinding } from "../../../src/world/worldProfileStore.js";
import type { OwnerIdentitySnapshot } from "../../../src/identity/ownerIdentity.js";

const REQUEST_TIMEOUT_MS = 10_000;
const EMERGENCY_TIMEOUT_MS = 1_500;
const SHUTDOWN_EXIT_TIMEOUT_MS = 3_500;
const FORCE_TERMINATION_CONFIRM_TIMEOUT_MS = 1_000;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;
type StreamCloseListener = () => void;

export interface ChildProcessPort {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit" | "close", listener: ExitListener): this;
  on(event: "error", listener: ErrorListener): this;
  once(event: "exit" | "close", listener: ExitListener): this;
  once(event: "error", listener: ErrorListener): this;
  off(event: "exit" | "close", listener: ExitListener): this;
  off(event: "error", listener: ErrorListener): this;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
}

export type SpawnChild = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessPort;

export interface SupervisedDesktopEventContext {
  readonly childGeneration: number;
}

export interface ChildSupervisorOptions {
  childEntry: string;
  configPath: string;
  workingDirectory: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  development: boolean;
  spawn?: SpawnChild;
}

interface ManagedChild {
  readonly process: ChildProcessPort;
  readonly generation: number;
  runtimeRevisionCursor: number;
  runtimeAuthorityExposed: boolean;
  readonly exitWaiters: Set<() => void>;
  readonly onExit: ExitListener;
  readonly onClose: ExitListener;
  readonly onProcessError: ErrorListener;
  readonly onStdinError: ErrorListener;
  readonly onStdoutError: ErrorListener;
  readonly onStderrError: ErrorListener;
  readonly onStdinClose: StreamCloseListener;
  readonly onStdoutClose: StreamCloseListener;
  readonly onStderrClose: StreamCloseListener;
  readonly onStdoutData: (chunk: Buffer | string) => void;
  state: "active" | "quarantined" | "terminated";
  exitObserved: boolean;
  closeObserved: boolean;
  listenersFinalized: boolean;
  failure: Error | undefined;
  restartOnExit: boolean;
}

interface PendingRequest {
  child: ManagedChild;
  readonly command: DesktopCommand;
  acknowledgementRequiredAfterDispatch: boolean;
  ownerRevisionConflictAfterDispatch: boolean;
  restartOnContainmentFailure: boolean;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CommittedProfileMutationError extends Error {
  constructor(readonly committed: DocumentEnvelope<CompanionProfile>) {
    super("PROFILE_RUNTIME_CONTAINMENT_FAILED: Profile committed but runtime containment failed");
    this.name = "CommittedProfileMutationError";
  }
}

export class ChildSupervisor {
  readonly #childEntry: string;
  readonly #configPath: string;
  readonly #workingDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #spawn: SpawnChild;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #ignoredShutdownResponseIds = new Set<string>();
  readonly #runtimeListeners = new Set<
    (event: DesktopEvent["event"], context: SupervisedDesktopEventContext) => void
  >();
  #child: ManagedChild | undefined;
  #requestSequence = 0;
  #childGenerationSequence = 0;
  #activeChildGeneration = 0;
  #runtimeRevisionHighWater = 0;
  #hasSpawnedChild = false;
  #restartCount = 0;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;
  #lineChunks: Buffer[] = [];
  #lineBytes = 0;

  constructor(options: ChildSupervisorOptions) {
    for (const value of [options.childEntry, options.configPath, options.workingDirectory]) {
      if (!win32.isAbsolute(value) || value.includes("%")) {
        throw new Error("WhiteLily child paths must be trusted absolute paths");
      }
    }
    this.#childEntry = win32.normalize(options.childEntry);
    this.#configPath = win32.normalize(options.configPath);
    this.#workingDirectory = win32.normalize(options.workingDirectory);
    this.#environment = { ...options.environment };
    // Packaging must retain Electron's RunAsNode fuse; the child is always fixed JavaScript.
    this.#environment.ELECTRON_RUN_AS_NODE = "1";
    this.#spawn = options.spawn ?? spawnChildProcess;
  }

  start(): void {
    if (this.#shuttingDown) throw new Error("WhiteLily child supervisor is shutting down");
    if (this.#child?.state === "quarantined") {
      throw new Error("WhiteLily child is quarantined until process exit");
    }
    this.#started = true;
    if (this.#child || this.#restartTimer) return;
    this.#spawnChild();
  }

  request<C extends DesktopCommand>(command: C): Promise<DesktopCommandResult<C>> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("WhiteLily child supervisor is shutting down"));
    }
    if (command.kind === "emergency_stop") {
      return this.emergencyStop() as Promise<DesktopCommandResult<C>>;
    }
    return this.#sendRequest(command, REQUEST_TIMEOUT_MS);
  }

  bindConfirmedWorld(
    binding: ConfirmedWorldBinding,
    intent: Extract<DesktopCommand, { kind: "bind_confirmed_world" }>,
  ): Promise<DesktopCommandResult<typeof intent>> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("WhiteLily child supervisor is shutting down"));
    }
    if (this.#child?.state === "quarantined") {
      return Promise.reject(new Error("WhiteLily child is quarantined until process exit"));
    }
    if (!this.#child) this.start();
    const child = this.#child;
    if (!child || child.state !== "active" || !child.process.stdin) {
      return Promise.reject(new Error("WhiteLily child is unavailable"));
    }
    const id = `desktop_${++this.#requestSequence}`;
    const request = parsePrivateChildRequest({
      version: DESKTOP_PROTOCOL_VERSION,
      id,
      privateCommand: { ...intent, binding },
    });
    return new Promise<DesktopCommandResult<typeof intent>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        const timeoutError = new Error(
          `WhiteLily child request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
        this.#quarantineChild(child, timeoutError, true);
        reject(timeoutError);
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        child,
        command: intent,
        acknowledgementRequiredAfterDispatch: true,
        ownerRevisionConflictAfterDispatch: false,
        restartOnContainmentFailure: true,
        resolve: (result) => resolve(result as DesktopCommandResult<typeof intent>),
        reject,
        timer,
      });
      try {
        child.process.stdin!.write(`${JSON.stringify(request)}\n`);
      } catch {
        this.#quarantineChild(child, new Error("WhiteLily child stdin failed"), true);
      }
    });
  }

  emergencyStop(): Promise<RuntimeSnapshot> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("WhiteLily child supervisor is shutting down"));
    }
    return this.#sendRequest({ kind: "emergency_stop" }, EMERGENCY_TIMEOUT_MS, (child) => {
      this.#quarantineChild(
        child,
        new Error("WhiteLily child emergency acknowledgement timed out"),
        true,
      );
    });
  }

  stopTask(): Promise<RuntimeSnapshot> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("WhiteLily child supervisor is shutting down"));
    }
    return this.#sendRequest({ kind: "stop_task" }, EMERGENCY_TIMEOUT_MS);
  }

  activeChildGeneration(): number {
    const child = this.#child;
    if (!child || child.state !== "active" || child.generation !== this.#activeChildGeneration) {
      throw new Error("WhiteLily child is unavailable");
    }
    return child.generation;
  }

  subscribe(
    listener: (event: DesktopEvent["event"], context: SupervisedDesktopEventContext) => void,
  ): () => void {
    this.#runtimeListeners.add(listener);
    return () => this.#runtimeListeners.delete(listener);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#started = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const child = this.#child;
    this.#shutdownPromise = child ? this.#shutdownChild(child) : Promise.resolve();
    return this.#shutdownPromise;
  }

  /**
   * Main-process last resort for the outer application deadline.
   * A kill return value is never termination confirmation: only process exit or
   * aggregate close can resolve this operation.
   */
  async forceTerminate(): Promise<void> {
    this.#shuttingDown = true;
    this.#started = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const child = this.#child;
    if (!child) return;
    child.restartOnExit = false;
    if (child.state === "active") {
      this.#quarantineChild(child, new Error("WhiteLily child force termination requested"), false);
    } else if (child.state === "quarantined") {
      this.#safeKill(child.process);
    }
    if (child.state === "terminated" || this.#child !== child) return;
    if (await this.#waitForExit(child, FORCE_TERMINATION_CONFIRM_TIMEOUT_MS)) return;
    throw new Error("WhiteLily child termination was not confirmed");
  }

  async #shutdownChild(child: ManagedChild): Promise<void> {
    if ((child.state as ManagedChild["state"]) === "quarantined") {
      throw new Error("WhiteLily quarantined child did not exit");
    }
    this.#failPendingForChild(child, new Error("WhiteLily child is shutting down"), true);
    let emergencyTimedOut = false;
    let timeoutKillSucceeded: boolean | undefined;
    try {
      await this.#sendRequest(
        { kind: "emergency_stop" },
        EMERGENCY_TIMEOUT_MS,
        (timedOutChild) => {
          emergencyTimedOut = true;
          timeoutKillSucceeded = this.#quarantineChild(
            timedOutChild,
            new Error("WhiteLily child emergency acknowledgement timed out"),
            false,
          );
        },
        true,
      );
    } catch (error) {
      if (emergencyTimedOut) {
        if (child.state === "terminated") return;
        if (timeoutKillSucceeded !== true) {
          throw new Error("WhiteLily child could not be killed");
        }
        throw new Error("WhiteLily child did not exit after termination request");
      }
      if (child.state === "terminated" || this.#child !== child) return;
      throw error;
    }

    if (child.state === "terminated" || this.#child !== child) return;
    try {
      child.process.stdin?.end();
    } catch {
      this.#quarantineChild(child, new Error("WhiteLily child stdin failed"), false);
    }
    if (await this.#waitForExit(child, SHUTDOWN_EXIT_TIMEOUT_MS)) return;
    if (child.state === "quarantined") {
      throw child.failure ?? new Error("WhiteLily quarantined child did not exit");
    }

    const killed = this.#quarantineChild(
      child,
      new Error("WhiteLily child EOF shutdown timed out"),
      false,
    );
    if ((child.state as ManagedChild["state"]) === "terminated") return;
    if (!killed) throw new Error("WhiteLily child could not be killed");
    throw new Error("WhiteLily child did not exit after termination request");
  }

  #spawnChild(): void {
    if (this.#child || this.#shuttingDown) return;
    const runtimeRevisionSeed = this.#hasSpawnedChild ? this.#nextRuntimeRevisionSeed() : 0;
    this.#resetProtocolBuffer();
    this.#ignoredShutdownResponseIds.clear();
    const childProcess = this.#spawn(
      process.execPath,
      [this.#childEntry, this.#configPath, String(runtimeRevisionSeed)],
      {
        cwd: this.#workingDirectory,
        env: { ...this.#environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const generation = ++this.#childGenerationSequence;
    this.#hasSpawnedChild = true;

    const child = {} as ManagedChild;
    Object.assign(child, {
      process: childProcess,
      generation,
      runtimeRevisionCursor: runtimeRevisionSeed,
      runtimeAuthorityExposed: false,
      exitWaiters: new Set<() => void>(),
      state: "active",
      exitObserved: false,
      closeObserved: false,
      listenersFinalized: false,
      failure: undefined,
      restartOnExit: false,
      onExit: (_code: number | null, _signal: NodeJS.Signals | null) => {
        if (child.exitObserved) return;
        child.exitObserved = true;
        this.#confirmTermination(child, new Error("WhiteLily child exited"));
      },
      onClose: (_code: number | null, _signal: NodeJS.Signals | null) => {
        if (child.closeObserved) return;
        child.closeObserved = true;
        this.#confirmTermination(child, new Error("WhiteLily child closed"));
        this.#finalizeClosedChild(child);
      },
      onProcessError: (_error: Error) => {
        this.#quarantineChild(child, new Error("WhiteLily child process failed"), true);
      },
      onStdinError: (_error: Error) => {
        this.#quarantineChild(child, new Error("WhiteLily child stdin failed"), true);
      },
      onStdoutError: (_error: Error) => {
        this.#quarantineChild(child, new Error("WhiteLily child stdout failed"), true);
      },
      onStderrError: (_error: Error) => {
        this.#quarantineChild(child, new Error("WhiteLily child stderr failed"), true);
      },
      onStdinClose: () => {
        child.process.stdin?.off("error", child.onStdinError);
        child.process.stdin?.off("close", child.onStdinClose);
        if (this.#hasPendingContainmentSensitiveMutation(child)) {
          this.#quarantineChild(
            child,
            new Error("WhiteLily child stdin closed before mutation acknowledgement"),
            true,
          );
        }
      },
      onStdoutClose: () => {
        child.process.stdout?.off("data", child.onStdoutData);
        child.process.stdout?.off("error", child.onStdoutError);
        child.process.stdout?.off("close", child.onStdoutClose);
        if (this.#hasPendingContainmentSensitiveMutation(child)) {
          this.#quarantineChild(
            child,
            new Error("WhiteLily child stdout closed before mutation acknowledgement"),
            true,
          );
        }
      },
      onStderrClose: () => {
        child.process.stderr?.off("error", child.onStderrError);
        child.process.stderr?.off("close", child.onStderrClose);
      },
      onStdoutData: (chunk: Buffer | string) => {
        this.#onStdoutData(child, chunk);
      },
    } satisfies ManagedChild);
    this.#child = child;
    this.#activeChildGeneration = generation;
    childProcess.on("error", child.onProcessError);
    childProcess.once("exit", child.onExit);
    childProcess.once("close", child.onClose);
    if (childProcess.stdin) {
      childProcess.stdin.on("error", child.onStdinError);
      childProcess.stdin.once("close", child.onStdinClose);
    }
    if (childProcess.stdout) {
      childProcess.stdout.on("error", child.onStdoutError);
      childProcess.stdout.once("close", child.onStdoutClose);
    }
    if (childProcess.stderr) {
      childProcess.stderr.on("error", child.onStderrError);
      childProcess.stderr.once("close", child.onStderrClose);
    }
    if (!childProcess.stdin || !childProcess.stdout || !childProcess.stderr) {
      this.#quarantineChild(
        child,
        new Error("WhiteLily child did not expose separate protocol streams"),
        true,
      );
      throw new Error("WhiteLily child did not expose separate protocol streams");
    }
    childProcess.stdout.on("data", child.onStdoutData);
    childProcess.stderr.resume();
  }

  #sendRequest<C extends DesktopCommand>(
    command: C,
    timeoutMs: number,
    onTimeout?: (child: ManagedChild) => void,
    allowDuringShutdown = false,
  ): Promise<DesktopCommandResult<C>> {
    if (this.#shuttingDown && !allowDuringShutdown) {
      return Promise.reject(new Error("WhiteLily child supervisor is shutting down"));
    }
    if (this.#child?.state === "quarantined") {
      return Promise.reject(new Error("WhiteLily child is quarantined until process exit"));
    }
    if (!this.#child) this.start();
    const child = this.#child;
    if (!child || child.state !== "active" || !child.process.stdin) {
      return Promise.reject(new Error("WhiteLily child is unavailable"));
    }

    const id = `desktop_${++this.#requestSequence}`;
    const request: DesktopRequest = parseDesktopRequest({
      version: DESKTOP_PROTOCOL_VERSION,
      id,
      command,
    });
    const validatedCommand = request.command;
    const acknowledgementRequiredAfterDispatch =
      isAcknowledgementSensitiveMutation(validatedCommand);
    return new Promise<DesktopCommandResult<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        const timeoutError = new Error(`WhiteLily child request timed out after ${timeoutMs}ms`);
        if (onTimeout) {
          onTimeout(child);
        } else if (
          pending.acknowledgementRequiredAfterDispatch ||
          isAuthorityInvalidatingCommand(pending.command)
        ) {
          this.#quarantineChild(child, timeoutError, !allowDuringShutdown);
        }
        reject(timeoutError);
      }, timeoutMs);
      this.#pending.set(id, {
        child,
        command: validatedCommand,
        acknowledgementRequiredAfterDispatch,
        ownerRevisionConflictAfterDispatch: false,
        restartOnContainmentFailure: !allowDuringShutdown,
        resolve: (result) => resolve(result as DesktopCommandResult<C>),
        reject,
        timer,
      });
      try {
        child.process.stdin!.write(`${JSON.stringify(request)}\n`);
      } catch {
        this.#quarantineChild(child, new Error("WhiteLily child stdin failed"), true);
      }
    });
  }

  #onStdoutData(child: ManagedChild, chunk: Buffer | string): void {
    if (child.state !== "active" || this.#child !== child) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && child.state === "active") {
      const newline = bytes.indexOf(0x0a, offset);
      const segmentEnd = newline < 0 ? bytes.length : newline;
      const segmentLength = segmentEnd - offset;
      if (segmentLength > MAX_DESKTOP_LINE_BYTES - this.#lineBytes) {
        this.#rejectMalformedProtocol(child);
        return;
      }
      if (segmentLength > 0) {
        this.#lineChunks.push(bytes.subarray(offset, segmentEnd));
        this.#lineBytes += segmentLength;
      }
      if (newline >= 0) {
        const line = Buffer.concat(this.#lineChunks, this.#lineBytes);
        this.#resetProtocolBuffer();
        this.#handleProtocolLine(child, line);
      }
      offset = newline < 0 ? bytes.length : newline + 1;
    }
  }

  #handleProtocolLine(child: ManagedChild, line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(utf8Decoder.decode(stripCarriageReturn(line)));
    } catch {
      this.#rejectMalformedProtocol(child);
      return;
    }
    if (hasOwn(value, "id")) {
      try {
        const response = parseDesktopResponse(value);
        const pending = this.#pending.get(response.id);
        if (!pending || pending.child !== child) {
          if (this.#ignoredShutdownResponseIds.delete(response.id)) return;
          throw new Error("unknown response");
        }
        if (response.ok && isRuntimeSnapshotCommand(pending.command)) {
          const runtimeResult = parseDesktopCommandResult(pending.command, response.result);
          this.#observeRuntimeSnapshot(child, runtimeResult);
        }
        if (response.ok) {
          const result = parseDesktopCommandResult(pending.command, response.result);
          if (
            pending.command.kind === "update_owner_identity" &&
            (pending.ownerRevisionConflictAfterDispatch ||
              !(pending.acknowledgementRequiredAfterDispatch
                ? ownerResponseAcknowledgesUpdate(pending.command, result as OwnerIdentitySnapshot)
                : ownerAcknowledgesUpdate(pending.command, result as OwnerIdentitySnapshot)))
          ) {
            throw new Error("owner update response does not acknowledge the pending command");
          }
          clearTimeout(pending.timer);
          this.#pending.delete(response.id);
          pending.resolve(result);
        } else {
          const responseError =
            response.error.code === "PROFILE_RUNTIME_CONTAINMENT_FAILED"
              ? new CommittedProfileMutationError(
                  correlateCommittedProfileMutation(pending.command, response.error.committed),
                )
              : new Error(`${response.error.code}: ${response.error.message}`);
          clearTimeout(pending.timer);
          this.#pending.delete(response.id);
          if (
            isAuthorityInvalidatingCommand(pending.command) ||
            response.error.code === "PROFILE_RUNTIME_CONTAINMENT_FAILED"
          ) {
            this.#quarantineChild(child, responseError, pending.restartOnContainmentFailure);
          }
          pending.reject(responseError);
        }
      } catch {
        this.#rejectMalformedProtocol(child);
      }
      return;
    }
    if (hasOwn(value, "event")) {
      try {
        const envelope = parseDesktopEvent(value);
        if (envelope.event.kind !== "account" && envelope.event.kind !== "owner_identity") {
          this.#observeRuntimeEvent(child, envelope.event.revision);
        }
        if (envelope.event.kind === "connection_invalidated") {
          child.runtimeAuthorityExposed = false;
        } else if (envelope.event.kind !== "account" && envelope.event.kind !== "owner_identity") {
          // A delta cannot prove that every other runtime field is terminal.
          // Once published, revoke it on child loss unless a full terminal
          // snapshot or authoritative invalidation subsequently clears it.
          child.runtimeAuthorityExposed = true;
        }
        if (envelope.event.kind === "owner_identity") {
          this.#acknowledgeOwnerUpdate(child, envelope.event.owner);
        }
        this.#publishRuntimeEvent(child, envelope.event);
      } catch {
        this.#rejectMalformedProtocol(child);
      }
      return;
    }
    this.#rejectMalformedProtocol(child);
  }

  #rejectMalformedProtocol(child: ManagedChild): void {
    this.#quarantineChild(child, new Error("WhiteLily child sent malformed protocol"), true);
  }

  #quarantineChild(child: ManagedChild, error: Error, restartOnExit: boolean): boolean {
    if (child.state === "terminated") return true;
    if (child.state === "quarantined") return false;
    child.state = "quarantined";
    child.failure = error;
    child.restartOnExit = restartOnExit;
    child.process.stdout?.off("data", child.onStdoutData);
    if (this.#child === child) this.#resetProtocolBuffer();
    this.#revokeExposedRuntimeAuthority(child);
    this.#failPendingForChild(child, error);
    return this.#safeKill(child.process);
  }

  #safeKill(child: ChildProcessPort): boolean {
    try {
      return child.kill();
    } catch {
      return false;
    }
  }

  #confirmTermination(child: ManagedChild, terminationError: Error): void {
    if (child.state === "terminated") return;
    const error = child.failure ?? terminationError;
    const restartOnExit = child.state === "active" || child.restartOnExit;
    this.#revokeExposedRuntimeAuthority(child);
    child.state = "terminated";
    child.process.stdout?.off("data", child.onStdoutData);
    const wasCurrent = this.#child === child;
    if (wasCurrent) {
      this.#child = undefined;
      this.#activeChildGeneration = 0;
      this.#resetProtocolBuffer();
    }
    this.#failPendingForChild(child, error);
    for (const waiter of child.exitWaiters) waiter();
    child.exitWaiters.clear();
    if (wasCurrent && restartOnExit) this.#scheduleRestart();
  }

  #finalizeClosedChild(child: ManagedChild): void {
    if (child.listenersFinalized) return;
    child.listenersFinalized = true;
    child.process.stdout?.off("data", child.onStdoutData);
    child.process.stdout?.off("error", child.onStdoutError);
    child.process.stdout?.off("close", child.onStdoutClose);
    child.process.stdin?.off("error", child.onStdinError);
    child.process.stdin?.off("close", child.onStdinClose);
    child.process.stderr?.off("error", child.onStderrError);
    child.process.stderr?.off("close", child.onStderrClose);
    child.process.off("error", child.onProcessError);
    child.process.off("exit", child.onExit);
    child.process.off("close", child.onClose);
  }

  #scheduleRestart(): void {
    if (
      !this.#started ||
      this.#shuttingDown ||
      this.#restartTimer ||
      this.#restartCount >= RESTART_DELAYS_MS.length ||
      (this.#hasSpawnedChild && this.#runtimeRevisionHighWater >= Number.MAX_SAFE_INTEGER)
    ) {
      return;
    }
    const delay = RESTART_DELAYS_MS[this.#restartCount]!;
    this.#restartCount += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.#spawnChild();
    }, delay);
  }

  #waitForExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
    if (child.state === "terminated") return Promise.resolve(true);
    return new Promise((resolveWait) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.exitWaiters.delete(onExited);
        resolveWait(exited);
      };
      const onExited = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.exitWaiters.add(onExited);
      if (child.state === "terminated") onExited();
    });
  }

  #failPendingForChild(child: ManagedChild, error: Error, ignoreLateResponses = false): void {
    for (const [id, pending] of this.#pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (ignoreLateResponses) this.#ignoredShutdownResponseIds.add(id);
      pending.reject(error);
    }
  }

  #hasPendingContainmentSensitiveMutation(child: ManagedChild): boolean {
    for (const pending of this.#pending.values()) {
      if (pending.child === child && pending.acknowledgementRequiredAfterDispatch) return true;
    }
    return false;
  }

  #acknowledgeOwnerUpdate(
    child: ManagedChild,
    owner: Extract<DesktopEvent["event"], { kind: "owner_identity" }>["owner"],
  ): void {
    for (const pending of this.#pending.values()) {
      if (pending.child !== child || pending.command.kind !== "update_owner_identity") continue;
      if (ownerAcknowledgesUpdate(pending.command, owner)) {
        pending.acknowledgementRequiredAfterDispatch = false;
      } else if (owner.revision > pending.command.expectedRevision) {
        pending.ownerRevisionConflictAfterDispatch = true;
      }
    }
  }

  #resetProtocolBuffer(): void {
    this.#lineChunks = [];
    this.#lineBytes = 0;
  }

  #observeRuntimeSnapshot(child: ManagedChild, snapshot: RuntimeSnapshot): void {
    if (
      child.state !== "active" ||
      this.#child !== child ||
      child.generation !== this.#activeChildGeneration
    ) {
      return;
    }
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < child.runtimeRevisionCursor ||
      snapshot.revision < 0
    ) {
      throw new Error("WhiteLily child runtime revision is invalid");
    }
    child.runtimeRevisionCursor = snapshot.revision;
    child.runtimeAuthorityExposed = !isAuthorityFreeTerminalRuntimeSnapshot(snapshot);
    this.#runtimeRevisionHighWater = Math.max(this.#runtimeRevisionHighWater, snapshot.revision);
  }

  #revokeExposedRuntimeAuthority(child: ManagedChild): void {
    if (
      !child.runtimeAuthorityExposed ||
      this.#shuttingDown ||
      this.#child !== child ||
      child.generation !== this.#activeChildGeneration ||
      this.#runtimeRevisionHighWater >= Number.MAX_SAFE_INTEGER
    ) {
      return;
    }
    child.runtimeAuthorityExposed = false;
    const revision = this.#runtimeRevisionHighWater + 1;
    child.runtimeRevisionCursor = revision;
    this.#runtimeRevisionHighWater = revision;
    const event: ConnectionInvalidatedEvent = {
      kind: "connection_invalidated",
      revision,
      reason: "runtime_failed",
      snapshot: {
        revision,
        lifecycle: "stopped",
        minecraft: { state: "disconnected", sessionId: null },
        codex: { state: "stopped", model: null },
        actions: null,
        task: null,
        lastError: null,
      },
    };
    this.#publishRuntimeEvent(child, event);
  }

  #publishRuntimeEvent(child: ManagedChild, event: DesktopEvent["event"]): void {
    for (const listener of this.#runtimeListeners) {
      try {
        listener(event, { childGeneration: child.generation });
      } catch {
        // Renderer observers cannot interfere with child supervision.
      }
    }
  }

  #observeRuntimeEvent(child: ManagedChild, revision: number): void {
    if (
      child.state !== "active" ||
      this.#child !== child ||
      child.generation !== this.#activeChildGeneration
    ) {
      return;
    }
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      child.runtimeRevisionCursor >= Number.MAX_SAFE_INTEGER ||
      revision !== child.runtimeRevisionCursor + 1
    ) {
      throw new Error("WhiteLily child runtime revision is invalid");
    }
    child.runtimeRevisionCursor = revision;
    this.#runtimeRevisionHighWater = Math.max(this.#runtimeRevisionHighWater, revision);
  }

  #nextRuntimeRevisionSeed(): number {
    if (this.#runtimeRevisionHighWater >= Number.MAX_SAFE_INTEGER) {
      throw new Error("WhiteLily child runtime revision is exhausted");
    }
    return this.#runtimeRevisionHighWater + 1;
  }
}

function spawnChildProcess(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return nodeSpawn(executable, [...args], options);
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

type RuntimeSnapshotCommand = Extract<
  DesktopCommand,
  {
    kind:
      | "get_status"
      | "start_runtime"
      | "stop_runtime"
      | "stop_task"
      | "emergency_stop"
      | "invalidate_connection";
  }
>;

function isRuntimeSnapshotCommand(command: DesktopCommand): command is RuntimeSnapshotCommand {
  return (
    command.kind === "get_status" ||
    command.kind === "start_runtime" ||
    command.kind === "stop_runtime" ||
    command.kind === "stop_task" ||
    command.kind === "emergency_stop" ||
    command.kind === "invalidate_connection"
  );
}

function isAuthorityInvalidatingCommand(
  command: DesktopCommand,
): command is Extract<
  DesktopCommand,
  { kind: "stop_runtime" | "emergency_stop" | "invalidate_connection" }
> {
  return (
    command.kind === "stop_runtime" ||
    command.kind === "emergency_stop" ||
    command.kind === "invalidate_connection"
  );
}

function isProfileMutation(
  command: DesktopCommand,
): command is Extract<DesktopCommand, { kind: "update_profile" | "set_behavior_mode" }> {
  return command.kind === "update_profile" || command.kind === "set_behavior_mode";
}

function isAcknowledgementSensitiveMutation(
  command: DesktopCommand,
): command is Extract<
  DesktopCommand,
  { kind: "update_owner_identity" | "update_profile" | "set_behavior_mode" }
> {
  return isProfileMutation(command) || command.kind === "update_owner_identity";
}

function ownerAcknowledgesUpdate(
  command: Extract<DesktopCommand, { kind: "update_owner_identity" }>,
  owner: OwnerIdentitySnapshot,
): boolean {
  return (
    command.expectedRevision < Number.MAX_SAFE_INTEGER &&
    owner.configured &&
    owner.ownerUsername === command.ownerUsername &&
    owner.revision === command.expectedRevision + 1
  );
}

function ownerResponseAcknowledgesUpdate(
  command: Extract<DesktopCommand, { kind: "update_owner_identity" }>,
  owner: OwnerIdentitySnapshot,
): boolean {
  return (
    owner.configured &&
    owner.ownerUsername === command.ownerUsername &&
    (owner.revision === command.expectedRevision ||
      (command.expectedRevision < Number.MAX_SAFE_INTEGER &&
        owner.revision === command.expectedRevision + 1))
  );
}

function correlateCommittedProfileMutation(
  command: DesktopCommand,
  committed: DocumentEnvelope<CompanionProfile>,
): DocumentEnvelope<CompanionProfile> {
  if (!isProfileMutation(command)) {
    throw new Error("committed profile evidence is unrelated to the pending command");
  }
  if (
    command.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    committed.revision !== command.expectedRevision + 1
  ) {
    throw new Error("committed profile revision does not match the pending command");
  }
  if (command.kind === "update_profile") {
    if (!isDeepStrictEqual(committed.value, command.profile)) {
      throw new Error("committed profile does not match the pending update");
    }
    return committed;
  }
  if (
    committed.value.mode !== command.mode ||
    !isDeepStrictEqual(committed.value.modeSettings[command.mode], command.settings)
  ) {
    throw new Error("committed profile mode does not match the pending update");
  }
  return committed;
}

function stripCarriageReturn(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
}
