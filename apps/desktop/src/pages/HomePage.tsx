import { useEffect, useRef, useState } from "react";
import { isAuthorityFreeTerminalRuntimeSnapshot } from "../../../../src/desktop/desktopProtocol";
import type { OwnerIdentitySnapshot } from "../../../../src/identity/ownerIdentity";
import type { RuntimeEvent, RuntimeSnapshot } from "../../../../src/runtime/runtimeEvents";
import { StatusCard } from "../components/StatusCard";
import { projectDesktopConnectionLifecycle } from "../connectionLifecycle";
import type { WhiteLilyDesktopApi } from "../desktopApi";
import type { Locale, MessageKey } from "../i18n/messageKeys";
import { translate } from "../i18n/translator";
import { createPreSnapshotEventAccumulator } from "./preSnapshotEventAccumulator";

interface HomePageProps {
  api: WhiteLilyDesktopApi;
  locale: Locale;
  ownerIdentity?: OwnerIdentitySnapshot | null;
  onInitialSnapshot?(snapshot: RuntimeSnapshot): void;
  onConnectionInvalidated?(): void;
}

interface RecentEvent {
  id: number;
  event: RuntimeEvent;
}

const MAX_RECENT_EVENTS = 5;

export function HomePage({
  api,
  locale,
  ownerIdentity,
  onInitialSnapshot,
  onConnectionInvalidated,
}: HomePageProps) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const [taskStopPending, setTaskStopPending] = useState(false);
  const [taskStopError, setTaskStopError] = useState(false);
  const [emergencyPending, setEmergencyPending] = useState(false);
  const [actionError, setActionError] = useState<"control" | "emergency" | null>(null);
  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const eventId = useRef(0);
  const mounted = useRef(false);
  const snapshotReady = useRef(false);
  const snapshotRequest = useRef(0);
  const revisionHighWater = useRef(0);
  const preSnapshotAccumulator = useRef<ReturnType<
    typeof createPreSnapshotEventAccumulator
  > | null>(null);
  const controlInFlight = useRef(false);
  const taskStopInFlight = useRef(false);
  const emergencyInFlight = useRef(false);
  const homeHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    homeHeading.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    snapshotReady.current = false;
    const pendingEvents = createPreSnapshotEventAccumulator();
    preSnapshotAccumulator.current = pendingEvents;
    const request = ++snapshotRequest.current;

    const unsubscribe = api.subscribeRuntime((event) => {
      if (!active || !mounted.current) return;
      if (
        event.kind === "connection_invalidated" &&
        !isAuthorityFreeTerminalRuntimeSnapshot(event.snapshot)
      ) {
        return;
      }
      if (event.revision <= revisionHighWater.current) return;
      revisionHighWater.current = event.revision;
      if (event.kind === "connection_invalidated") {
        pendingEvents.clear();
        snapshotRequest.current += 1;
        snapshotReady.current = true;
        setSnapshot(event.snapshot);
        onConnectionInvalidated?.();
        return;
      }
      if (!snapshotReady.current) pendingEvents.add(event);
      else setSnapshot((current) => (current ? applyRuntimeEvent(current, event) : current));
      eventId.current += 1;
      const recent = { id: eventId.current, event };
      setRecentEvents((current) => [...current, recent].slice(-MAX_RECENT_EVENTS));
    });

    void api.status().then(
      (initialSnapshot) => {
        const retainedEvents = pendingEvents.drain();
        if (!active || !mounted.current || snapshotRequest.current !== request) return;
        snapshotReady.current = true;
        const authoritativeSnapshot = retainedEvents.reduce(applyRuntimeEvent, initialSnapshot);
        revisionHighWater.current = Math.max(
          revisionHighWater.current,
          authoritativeSnapshot.revision,
        );
        setSnapshot(authoritativeSnapshot);
        setLoadFailed(false);
        onInitialSnapshot?.(authoritativeSnapshot);
      },
      () => {
        pendingEvents.clear();
        if (!active || !mounted.current || snapshotRequest.current !== request) return;
        snapshotReady.current = true;
        setLoadFailed(true);
      },
    );

    return () => {
      active = false;
      mounted.current = false;
      pendingEvents.clear();
      if (preSnapshotAccumulator.current === pendingEvents) {
        preSnapshotAccumulator.current = null;
      }
      unsubscribe();
    };
  }, [api, onConnectionInvalidated, onInitialSnapshot]);

  const invokeRuntimeControl = async (): Promise<void> => {
    if (!snapshot || controlInFlight.current || emergencyInFlight.current) return;
    if (
      snapshot.lifecycle !== "running" &&
      snapshot.lifecycle !== "starting" &&
      projectDesktopConnectionLifecycle({ runtime: snapshot }) !== "connected"
    ) {
      onConnectionInvalidated?.();
      return;
    }
    controlInFlight.current = true;
    const request = ++snapshotRequest.current;
    setControlPending(true);
    setActionError(null);
    try {
      const next =
        snapshot.lifecycle === "running" || snapshot.lifecycle === "starting"
          ? await api.stop()
          : await api.start();
      if (!mounted.current || snapshotRequest.current !== request) return;
      snapshotReady.current = true;
      setSnapshot((current) => preferNewerSnapshot(current, next));
      setLoadFailed(false);
    } catch {
      if (mounted.current && snapshotRequest.current === request) setActionError("control");
    } finally {
      controlInFlight.current = false;
      if (mounted.current) setControlPending(false);
    }
  };

  const invokeEmergencyStop = async (): Promise<void> => {
    if (emergencyInFlight.current) return;
    emergencyInFlight.current = true;
    const pendingEvents = preSnapshotAccumulator.current;
    const request = ++snapshotRequest.current;
    setEmergencyPending(true);
    setActionError(null);
    try {
      const next = await api.emergencyStop();
      pendingEvents?.clear();
      if (!mounted.current || snapshotRequest.current !== request) return;
      snapshotReady.current = true;
      setSnapshot((current) => preferNewerSnapshot(current, next));
      setLoadFailed(false);
      setActionError(null);
    } catch {
      pendingEvents?.clear();
      if (mounted.current && snapshotRequest.current === request) {
        snapshotReady.current = true;
        setActionError("emergency");
      }
    } finally {
      emergencyInFlight.current = false;
      if (mounted.current) setEmergencyPending(false);
    }
  };

  const invokeTaskStop = async (): Promise<void> => {
    if (!snapshot?.task || taskStopInFlight.current) return;
    taskStopInFlight.current = true;
    const request = ++snapshotRequest.current;
    setTaskStopPending(true);
    setTaskStopError(false);
    try {
      const next = await api.stopTask();
      if (!mounted.current || snapshotRequest.current !== request) return;
      snapshotReady.current = true;
      setSnapshot((current) => preferNewerSnapshot(current, next));
      setLoadFailed(false);
    } catch {
      if (mounted.current && snapshotRequest.current === request) setTaskStopError(true);
    } finally {
      taskStopInFlight.current = false;
      if (mounted.current) setTaskStopPending(false);
    }
  };

  const isRunning = snapshot?.lifecycle === "running" || snapshot?.lifecycle === "starting";
  const connectionLifecycle = snapshot
    ? projectDesktopConnectionLifecycle({ runtime: snapshot })
    : "idle";
  const connectionTone =
    connectionLifecycle === "connected"
      ? "positive"
      : connectionLifecycle === "failed" || snapshot?.minecraft.state === "reconnecting"
        ? "warning"
        : "calm";

  return (
    <main className="home" id="home" data-connection-lifecycle={connectionLifecycle}>
      <div
        className="home-scroll"
        role="region"
        aria-label={translate(locale, "app.runtimeOverview")}
      >
        <header className="home-header">
          <div>
            <p className="home-eyebrow">{translate(locale, "app.tagline")}</p>
            <h1 ref={homeHeading} tabIndex={-1}>
              {translate(locale, "app.runtimeOverview")}
            </h1>
            <p className="home-subtitle">{translate(locale, "app.runtimeSubtitle")}</p>
          </div>
          <div className="runtime-actions">
            {snapshot ? (
              <button
                className="control-button"
                type="button"
                disabled={controlPending || emergencyPending}
                onClick={() => void invokeRuntimeControl()}
              >
                {controlPending
                  ? translate(locale, "action.controlPending")
                  : translate(locale, isRunning ? "action.stop" : "action.start")}
              </button>
            ) : null}
            <span
              className={`lifecycle-chip lifecycle-chip--${
                snapshot?.lifecycle ?? (loadFailed || actionError ? "failed" : "idle")
              }`}
            >
              {snapshot
                ? lifecycleText(locale, snapshot.lifecycle)
                : translate(
                    locale,
                    loadFailed || actionError ? "lifecycle.failed" : "loading.status",
                  )}
            </span>
          </div>
        </header>

        {!snapshot && !loadFailed && !actionError ? (
          <section className="state-panel" role="status" aria-live="polite">
            <span className="loading-spinner" aria-hidden="true" />
            {translate(locale, "loading.status")}
          </section>
        ) : null}

        {loadFailed ? (
          <section className="state-panel state-panel--error" role="alert">
            {translate(locale, "error.status")}
          </section>
        ) : null}

        {actionError ? (
          <p className="action-error" role="alert">
            {translate(locale, actionError === "emergency" ? "error.emergency" : "error.control")}
          </p>
        ) : null}

        {snapshot ? (
          <>
            <section className="status-grid" aria-label={translate(locale, "section.systemStatus")}>
              <StatusCard
                id="connection"
                title={translate(locale, "card.connection")}
                value={minecraftText(locale, snapshot.minecraft.state)}
                detail={lifecycleText(locale, snapshot.lifecycle)}
                tone={connectionTone}
              />
              {ownerIdentity?.configured && ownerIdentity.ownerUsername ? (
                <StatusCard
                  id="owner"
                  title={translate(locale, "card.owner")}
                  value={ownerIdentity.ownerUsername}
                  detail={translate(
                    locale,
                    ownerIdentity.presence === "online"
                      ? "owner.online"
                      : ownerIdentity.presence === "offline"
                        ? "owner.offline"
                        : "owner.waitingState",
                  )}
                  tone={
                    ownerIdentity.presence === "online"
                      ? "positive"
                      : ownerIdentity.presence === "offline"
                        ? "warning"
                        : "calm"
                  }
                >
                  {ownerIdentity.presence !== "online" ? (
                    <p className="owner-waiting">{translate(locale, "owner.waiting")}</p>
                  ) : null}
                </StatusCard>
              ) : null}
              <StatusCard
                id="world"
                title={translate(locale, "card.currentWorld")}
                value={translate(locale, "status.notProvided")}
                detail={minecraftText(locale, snapshot.minecraft.state)}
              />
              <StatusCard
                id="companion"
                title={translate(locale, "card.companionMode")}
                value={translate(locale, "status.notProvided")}
                detail={codexText(locale, snapshot.codex.state)}
              />
              <StatusCard
                id="model"
                title={translate(locale, "card.model")}
                value={snapshot.codex.model ?? translate(locale, "status.noModel")}
                detail={codexText(locale, snapshot.codex.state)}
                tone={snapshot.codex.state === "ready" ? "positive" : "calm"}
              />
              <StatusCard
                id="safety"
                title={translate(locale, "card.safetyPreset")}
                value={translate(locale, "status.notProvided")}
                detail={lifecycleText(locale, snapshot.lifecycle)}
              />
              {snapshot.task ? (
                <StatusCard
                  id="task"
                  title={translate(locale, "card.currentTask")}
                  value={snapshot.task.goal}
                  detail={translate(locale, `task.status.${snapshot.task.status}`)}
                  tone={snapshot.task.status === "running" ? "positive" : "warning"}
                >
                  <TaskDetails
                    locale={locale}
                    snapshot={snapshot}
                    stopPending={taskStopPending}
                    stopError={taskStopError}
                    onStop={() => void invokeTaskStop()}
                  />
                </StatusCard>
              ) : (
                <StatusCard
                  id="budget"
                  title={translate(locale, "card.taskBudget")}
                  value={translate(locale, "budget.noActiveTask")}
                />
              )}
            </section>

            {snapshot.lastError ? (
              <p className="runtime-error" role="alert">
                {translate(locale, "error.runtime", { code: snapshot.lastError.code })}
              </p>
            ) : null}
          </>
        ) : null}

        <section
          className="activity-panel"
          aria-label={translate(locale, "section.recentActivity")}
        >
          <div className="section-heading">
            <div>
              <p className="section-kicker">{translate(locale, "section.systemStatus")}</p>
              <h2>{translate(locale, "section.recentActivity")}</h2>
            </div>
            <span className="activity-count">{recentEvents.length}</span>
          </div>
          {recentEvents.length === 0 ? (
            <p className="empty-state">{translate(locale, "activity.empty")}</p>
          ) : (
            <ol className="activity-list" aria-live="polite">
              {recentEvents.map(({ id, event }) => (
                <li key={id}>
                  <span className="activity-marker" aria-hidden="true" />
                  {eventText(locale, event)}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="safety-rail" aria-labelledby="emergency-heading">
        <div>
          <h2 id="emergency-heading">{translate(locale, "action.emergency")}</h2>
          <p>{translate(locale, "action.emergencyHelp")}</p>
        </div>
        <button
          className="emergency-button"
          type="button"
          disabled={emergencyPending}
          onClick={() => void invokeEmergencyStop()}
        >
          <span className="emergency-button__icon" aria-hidden="true">
            ■
          </span>
          {translate(locale, emergencyPending ? "action.emergencyPending" : "action.emergency")}
        </button>
      </section>
    </main>
  );
}

function TaskDetails({
  locale,
  snapshot,
  stopPending,
  stopError,
  onStop,
}: {
  locale: Locale;
  snapshot: RuntimeSnapshot;
  stopPending: boolean;
  stopError: boolean;
  onStop(): void;
}) {
  const task = snapshot.task!;
  const limits: readonly [MessageKey, number, MessageKey][] = [
    ["task.limit.toolCalls", task.effectiveLimits.maxToolCalls, "task.unit.count"],
    ["task.limit.blockChanges", task.effectiveLimits.maxBlockChanges, "task.unit.count"],
    ["task.limit.travel", task.effectiveLimits.maxHorizontalTravel, "task.unit.blocks"],
    ["task.limit.duration", task.effectiveLimits.maxDurationMs, "task.unit.milliseconds"],
    ["task.limit.dangerous", task.effectiveLimits.maxDangerousOperations, "task.unit.count"],
  ];

  return (
    <div className="task-details">
      <div>
        <p className="task-details__label">{translate(locale, "task.allowedActions")}</p>
        <ul className="task-action-list">
          {task.allowedActions.map((action) => (
            <li key={action}>
              <code>{action}</code>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="task-details__label">{translate(locale, "task.effectiveLimits")}</p>
        <dl className="task-limit-list">
          {limits.map(([label, value, unit]) => (
            <div key={label}>
              <dt>{translate(locale, label)}</dt>
              <dd>
                {value} {translate(locale, unit)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="task-started">
        <span>{translate(locale, "task.startedAt")}</span>
        <time dateTime={task.startedAt}>{task.startedAt}</time>
      </p>
      <h4 className="task-details__label">{translate(locale, "card.taskBudget")}</h4>
      <BudgetSummary locale={locale} snapshot={snapshot} />
      <button
        className="secondary-button task-stop-button"
        type="button"
        disabled={stopPending}
        onClick={onStop}
      >
        {translate(locale, stopPending ? "task.stopPending" : "task.stop")}
      </button>
      {stopError ? (
        <p className="task-stop-error" role="alert">
          {translate(locale, "task.stopError")}
        </p>
      ) : null}
    </div>
  );
}

function BudgetSummary({ locale, snapshot }: { locale: Locale; snapshot: RuntimeSnapshot }) {
  const budget = snapshot.task!.budget;
  const rows: readonly [MessageKey, number, number][] = [
    ["budget.toolCalls", budget.toolCalls, budget.limits.maxToolCalls],
    ["budget.blockChanges", budget.blockChanges, budget.limits.maxBlockChanges],
    ["budget.travel", budget.horizontalTravel, budget.limits.maxHorizontalTravel],
    ["budget.dangerous", budget.dangerousOperations, budget.limits.maxDangerousOperations],
  ];

  return (
    <ul className="budget-list">
      {rows.map(([key, used, limit]) => (
        <li key={key}>
          <span id={`budget-${key}`}>{translate(locale, key, { used, limit })}</span>
          <meter
            aria-labelledby={`budget-${key}`}
            aria-valuetext={translate(locale, key, { used, limit })}
            min="0"
            max={Math.max(limit, 1)}
            value={Math.min(used, limit)}
          />
        </li>
      ))}
    </ul>
  );
}

function applyRuntimeEvent(snapshot: RuntimeSnapshot, event: RuntimeEvent): RuntimeSnapshot {
  if (event.revision <= snapshot.revision) return snapshot;
  switch (event.kind) {
    case "lifecycle":
      return { ...snapshot, revision: event.revision, lifecycle: event.state };
    case "minecraft":
      return { ...snapshot, revision: event.revision, minecraft: event.state };
    case "codex":
      return { ...snapshot, revision: event.revision, codex: event.state };
    case "task":
      return { ...snapshot, revision: event.revision, task: event.task };
    case "error":
      return { ...snapshot, revision: event.revision, lastError: event.error };
  }
}

function preferNewerSnapshot(
  current: RuntimeSnapshot | null,
  candidate: RuntimeSnapshot,
): RuntimeSnapshot {
  return current === null || candidate.revision >= current.revision ? candidate : current;
}

function lifecycleText(locale: Locale, state: RuntimeSnapshot["lifecycle"]): string {
  return translate(locale, `lifecycle.${state}`);
}

function minecraftText(locale: Locale, state: RuntimeSnapshot["minecraft"]["state"]): string {
  return translate(locale, `minecraft.${state}`);
}

function codexText(locale: Locale, state: RuntimeSnapshot["codex"]["state"]): string {
  return translate(locale, `codex.${state}`);
}

function eventText(locale: Locale, event: RuntimeEvent): string {
  switch (event.kind) {
    case "lifecycle":
      return translate(locale, "activity.lifecycle", {
        state: lifecycleText(locale, event.state),
      });
    case "minecraft":
      return translate(locale, "activity.minecraft", {
        state: minecraftText(locale, event.state.state),
      });
    case "codex":
      return translate(locale, "activity.codex", {
        state: codexText(locale, event.state.state),
      });
    case "task":
      return translate(locale, event.task ? "activity.taskStarted" : "activity.taskEnded");
    case "error":
      return translate(locale, "activity.error", { code: event.error.code });
  }
}
