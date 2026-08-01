const QUIT_DEADLINE_MS = 5_000;

export interface ApplicationPort {
  quit(): void;
}

export interface LifecycleSupervisorPort {
  shutdown(): Promise<void>;
  forceTerminate(): Promise<void>;
}

export interface ApplicationLifecycleOptions {
  app: ApplicationPort;
  supervisor: LifecycleSupervisorPort;
  cleanup(): void;
}

type ShutdownOutcome = "confirmed_exit" | "failed" | "deadline";

export class ApplicationLifecycle {
  readonly #app: ApplicationPort;
  readonly #supervisor: LifecycleSupervisorPort;
  readonly #cleanup: () => void;
  #quitPromise: Promise<void> | undefined;
  #isQuitting = false;

  constructor(options: ApplicationLifecycleOptions) {
    this.#app = options.app;
    this.#supervisor = options.supervisor;
    this.#cleanup = options.cleanup;
  }

  get isQuitting(): boolean {
    return this.#isQuitting;
  }

  quit(): Promise<void> {
    if (this.#quitPromise) return this.#quitPromise;
    this.#isQuitting = true;
    const operation = this.#performQuit();
    this.#quitPromise = operation;
    void operation.catch(() => {
      if (this.#quitPromise !== operation) return;
      this.#quitPromise = undefined;
      this.#isQuitting = false;
    });
    return operation;
  }

  async #performQuit(): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ShutdownOutcome>((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), QUIT_DEADLINE_MS);
    });
    let shutdown: Promise<ShutdownOutcome>;
    try {
      shutdown = Promise.resolve(this.#supervisor.shutdown()).then(
        () => "confirmed_exit" as const,
        () => "failed" as const,
      );
    } catch {
      shutdown = Promise.resolve("failed");
    }

    const outcome = await Promise.race([shutdown, deadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (outcome !== "confirmed_exit") {
      await this.#supervisor.forceTerminate();
    }
    try {
      this.#cleanup();
    } catch {
      // Confirmed child containment allows application exit despite cleanup failure.
    }
    try {
      this.#app.quit();
    } catch {
      // Quit failure is contained at the application authority boundary.
    }
  }
}
