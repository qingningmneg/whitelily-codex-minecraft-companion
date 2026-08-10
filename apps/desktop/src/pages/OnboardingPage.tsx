import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountSnapshot } from "../../../../src/codex/accountService";
import { parseMinecraftJavaUsername } from "../../../../src/identity/ownerIdentity";
import type { ModelCatalogSnapshot, ModelSelectionInput } from "../../../../src/codex/modelCatalog";
import type { RuntimeSnapshot } from "../../../../src/runtime/runtimeEvents";
import type { Pcl2Candidate } from "../../src-main/discovery/pcl2Discovery";
import type { LanCandidate } from "../../src-main/discovery/lanDetector";
import type {
  MinecraftComponentId,
  MinecraftComponentState,
  MinecraftComponentStatus,
} from "../../src-main/minecraftComponents";
import { LanCandidateCard } from "../components/LanCandidateCard";
import { ModelPicker } from "../components/ModelPicker";
import { OnboardingProgress, type OnboardingStep } from "../components/OnboardingProgress";
import type { WhiteLilyDesktopApi } from "../desktopApi";
import type { Locale, MessageKey } from "../i18n/messageKeys";
import { translate } from "../i18n/translator";

export const ONBOARDING_STORAGE_KEY = "whitelily.onboarding.v1";

const STORAGE_VERSION = 3;
const MAX_STORAGE_BYTES = 2_048;
const MAX_LOGIN_POLL_MS = 10 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 250;
const LAN_POLL_INTERVAL_MS = 1_000;
const LAN_IDLE_POLL_INTERVAL_MS = 5_000;
const FAST_LAN_POLL_ATTEMPTS = 60;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

type SafeProgressHint = "login" | "model" | "owner" | "pcl2" | "lan" | "ready";

interface SafePreferences {
  version: 3;
  locale: Locale;
  progressHint: SafeProgressHint;
}

interface ReadOnboardingPreferencesResult {
  preferences: SafePreferences;
  legacyMigrationPending: boolean;
  legacyModelCandidate: ModelSelectionInput | null;
}

interface OnboardingPageProps {
  api: WhiteLilyDesktopApi;
  locale: Locale;
  active: boolean;
  onReady(snapshot: RuntimeSnapshot): void;
}

interface LoginIntent {
  readonly generation: number;
  cancelRequested: boolean;
}

interface LoginPollWait {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly wake: () => void;
}

interface CatalogLoadIntent {
  readonly requestId: number;
  readonly generation: number;
  readonly promise: Promise<void>;
}

interface OwnerUpdateIntent {
  readonly requestId: number;
  readonly generation: number;
}

interface LanDiscoveryIntent {
  readonly requestId: number;
  readonly generation: number;
  readonly promise: Promise<readonly LanCandidate[]>;
}

interface CandidateComponentEntry {
  readonly status: MinecraftComponentStatus | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly bridgeSelected: boolean;
  readonly avatarSelected: boolean;
}

const defaultPreferences: SafePreferences = {
  version: STORAGE_VERSION,
  locale: "zh-CN",
  progressHint: "login",
};

export function OnboardingPage({ api, locale, active, onReady }: OnboardingPageProps) {
  const [step, setStep] = useState<OnboardingStep>("environment");
  const [catalog, setCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pcl2Candidates, setPcl2Candidates] = useState<readonly Pcl2Candidate[]>([]);
  const [pcl2Loading, setPcl2Loading] = useState(false);
  const [lanCandidates, setLanCandidates] = useState<readonly LanCandidate[]>([]);
  const [lanLoading, setLanLoading] = useState(false);
  const [lanRefreshEpoch, setLanRefreshEpoch] = useState(0);
  const [componentEntries, setComponentEntries] = useState<
    ReadonlyMap<string, CandidateComponentEntry>
  >(() => new Map());
  const [loginPending, setLoginPending] = useState(false);
  const [ownerDraft, setOwnerDraft] = useState("");
  const [ownerRevision, setOwnerRevision] = useState<number | null>(null);
  const [ownerPending, setOwnerPending] = useState(false);
  const [ownerMessageKey, setOwnerMessageKey] = useState<MessageKey | null>(null);
  const [ownerMessageIsAlert, setOwnerMessageIsAlert] = useState(false);
  const [connectingCandidate, setConnectingCandidate] = useState<string | null>(null);
  const [actionRecoveryAvailable, setActionRecoveryAvailable] = useState(false);
  const [actionRetryPending, setActionRetryPending] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const mounted = useRef(true);
  const flowGeneration = useRef(0);
  const activeLoginIntent = useRef<LoginIntent | null>(null);
  const loginAttempt = useRef<string | null>(null);
  const loginPollWait = useRef<LoginPollWait | null>(null);
  const catalogRequestId = useRef(0);
  const catalogInFlight = useRef<CatalogLoadIntent | null>(null);
  const ownerUpdateRequestId = useRef(0);
  const activeOwnerUpdate = useRef<OwnerUpdateIntent | null>(null);
  const lanDiscoveryGeneration = useRef(0);
  const lanDiscoveryRequestId = useRef(0);
  const lanDiscoveryInFlight = useRef<LanDiscoveryIntent | null>(null);
  const lanPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lanPreservedErrorKey = useRef<MessageKey | null>(null);
  const componentGeneration = useRef(0);
  const componentEntriesRef = useRef(componentEntries);
  componentEntriesRef.current = componentEntries;
  const observedLocale = useRef(locale);
  const heading = useRef<HTMLHeadingElement>(null);
  const ownerAlert = useRef<HTMLParagraphElement>(null);
  const initialPreferences = useRef(readOnboardingPreferences());
  const preferences = useRef(initialPreferences.current.preferences);
  const legacyMigrationPending = useRef(initialPreferences.current.legacyMigrationPending);
  const legacyModelCandidate = useRef(initialPreferences.current.legacyModelCandidate);
  const legacyMigrationRequest = useRef<Promise<ModelCatalogSnapshot> | null>(null);
  const resumeHint = useRef(preferences.current.progressHint);
  const resumedPcl2 = useRef(false);

  const persist = useCallback((patch: Partial<Omit<SafePreferences, "version">>) => {
    const next: SafePreferences = { ...preferences.current, ...patch, version: STORAGE_VERSION };
    preferences.current = next;
    if (legacyMigrationPending.current) {
      writeLegacyOnboardingPreferences(next, legacyModelCandidate.current);
    } else {
      writeOnboardingPreferences(next);
    }
  }, []);

  const clearLoginWait = useCallback((): void => {
    const pending = loginPollWait.current;
    loginPollWait.current = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.wake();
  }, []);

  const invalidateCatalogLoad = useCallback((): void => {
    catalogRequestId.current += 1;
    catalogInFlight.current = null;
    if (mounted.current) setCatalogLoading(false);
  }, []);

  const migrateLegacyModelPreference = useCallback((): Promise<ModelCatalogSnapshot> => {
    const existing = legacyMigrationRequest.current;
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(() => api.migrateModelPreference(legacyModelCandidate.current))
      .then((snapshot) => {
        if (!snapshot.legacyMigrationCompleted) throw new Error("MODEL_UNAVAILABLE");
        return snapshot;
      });
    legacyMigrationRequest.current = operation;
    void operation.catch(() => {
      if (legacyMigrationRequest.current === operation) legacyMigrationRequest.current = null;
    });
    return operation;
  }, [api]);

  const loadOwnerIdentity = useCallback(
    async (
      generation: number,
      continueDownstream = false,
      authorityIsCurrent: () => boolean = () => true,
    ): Promise<void> => {
      const isCurrent = (): boolean =>
        mounted.current && generation === flowGeneration.current && authorityIsCurrent();
      if (!isCurrent()) return;
      activeOwnerUpdate.current = null;
      lanDiscoveryGeneration.current += 1;
      lanDiscoveryInFlight.current = null;
      lanPreservedErrorKey.current = null;
      if (lanPollTimer.current !== null) clearTimeout(lanPollTimer.current);
      lanPollTimer.current = null;
      setOwnerPending(false);
      setStep("owner");
      persist({ progressHint: "owner" });
      setOwnerRevision(null);
      setOwnerDraft("");
      setOwnerMessageKey(null);
      setOwnerMessageIsAlert(false);
      try {
        const identity = await api.readOwnerIdentity();
        if (!isCurrent()) return;
        setOwnerRevision(identity.revision);
        setOwnerDraft(identity.configured && identity.ownerUsername ? identity.ownerUsername : "");
        if (continueDownstream && identity.configured) setStep("pcl2");
      } catch (error) {
        if (!isCurrent()) return;
        setOwnerMessageKey(safeOwnerErrorKey(error));
        setOwnerMessageIsAlert(true);
      }
    },
    [api, persist],
  );

  const loadCatalog = useCallback(
    async (generation: number): Promise<void> => {
      if (!mounted.current || generation !== flowGeneration.current) return;
      const pending = catalogInFlight.current;
      if (pending?.generation === generation) return pending.promise;

      const requestId = ++catalogRequestId.current;
      const isCurrent = (): boolean =>
        mounted.current &&
        generation === flowGeneration.current &&
        catalogRequestId.current === requestId &&
        catalogInFlight.current?.requestId === requestId;
      setCatalogLoading(true);

      const operation = Promise.resolve().then(async () => {
        try {
          if (!isCurrent()) return;
          let liveCatalog: ModelCatalogSnapshot;
          try {
            liveCatalog = await api.listModels();
          } catch (error) {
            if (!isCurrent()) return;
            setStep("model");
            setErrorKey(safeOnboardingErrorKey(asStableError(error, "MODEL_UNAVAILABLE")));
            return;
          }
          if (!isCurrent()) return;

          if (!liveCatalog.legacyMigrationCompleted) {
            try {
              liveCatalog = await migrateLegacyModelPreference();
            } catch (error) {
              if (!isCurrent()) return;
              setStep("model");
              setErrorKey(safeOnboardingErrorKey(asStableError(error, "MODEL_UNAVAILABLE")));
              return;
            }
          }
          if (!isCurrent()) return;
          legacyMigrationPending.current = false;
          legacyModelCandidate.current = null;
          writeOnboardingPreferences(preferences.current);
          const wantsDownstreamResume =
            resumeHint.current === "pcl2" ||
            resumeHint.current === "lan" ||
            resumeHint.current === "ready";
          const wantsOwnerResume = resumeHint.current === "owner";
          setCatalog(liveCatalog);
          const liveModelAuthorityReady = liveCatalog.models.length > 0;
          setErrorKey(liveModelAuthorityReady ? null : "onboarding.error.MODEL_UNAVAILABLE");

          if (!isCurrent()) return;
          if (wantsOwnerResume && liveModelAuthorityReady) {
            await loadOwnerIdentity(generation, false, isCurrent);
          } else if (wantsDownstreamResume && liveModelAuthorityReady) {
            await loadOwnerIdentity(generation, true, isCurrent);
          } else {
            setStep("model");
            persist({ progressHint: "model" });
          }
        } finally {
          if (catalogInFlight.current?.requestId === requestId) {
            catalogInFlight.current = null;
            if (mounted.current) setCatalogLoading(false);
          }
        }
      });
      catalogInFlight.current = { requestId, generation, promise: operation };
      return operation;
    },
    [api, loadOwnerIdentity, migrateLegacyModelPreference, persist],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flowGeneration.current += 1;
      activeOwnerUpdate.current = null;
      invalidateCatalogLoad();
      const intent = activeLoginIntent.current;
      if (intent) intent.cancelRequested = true;
      activeLoginIntent.current = null;
      clearLoginWait();
      const attemptId = loginAttempt.current;
      loginAttempt.current = null;
      if (attemptId) void api.cancelChatGptLogin(attemptId).catch(() => undefined);
    };
  }, [api, clearLoginWait, invalidateCatalogLoad]);

  useEffect(() => {
    if (!active) {
      flowGeneration.current += 1;
      lanDiscoveryGeneration.current += 1;
      lanDiscoveryInFlight.current = null;
      lanPreservedErrorKey.current = null;
      if (lanPollTimer.current !== null) clearTimeout(lanPollTimer.current);
      lanPollTimer.current = null;
      activeOwnerUpdate.current = null;
      setOwnerPending(false);
      invalidateCatalogLoad();
      setStep("environment");
      setActionRecoveryAvailable(false);
      setActionRetryPending(false);
      return;
    }
    invalidateCatalogLoad();
    const generation = ++flowGeneration.current;
    activeOwnerUpdate.current = null;
    setOwnerPending(false);
    setStep("environment");
    setActionRecoveryAvailable(false);
    setActionRetryPending(false);
    setErrorKey(null);
    void api.getAccount().then(
      async (account) => {
        if (!mounted.current || generation !== flowGeneration.current) return;
        if (isSignedIn(account)) {
          await loadCatalog(generation);
          return;
        }
        setStep("login");
        persist({ progressHint: "login" });
      },
      (error) => {
        if (!mounted.current || generation !== flowGeneration.current) return;
        setStep("login");
        setErrorKey(safeOnboardingErrorKey(asStableError(error, "CODEX_NOT_LOGGED_IN")));
      },
    );
  }, [active, api, invalidateCatalogLoad, loadCatalog, persist]);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  useEffect(() => {
    if (ownerMessageIsAlert) ownerAlert.current?.focus();
  }, [ownerMessageIsAlert, ownerMessageKey]);

  useEffect(() => {
    const localeChanged = observedLocale.current !== locale;
    observedLocale.current = locale;
    persist({ locale });
    if (!localeChanged) return;
    const pendingCatalog = catalogInFlight.current;
    if (!pendingCatalog) return;
    invalidateCatalogLoad();
    if (active) void loadCatalog(flowGeneration.current);
  }, [active, invalidateCatalogLoad, loadCatalog, locale, persist]);

  const startLogin = async (): Promise<void> => {
    if (loginPending) return;
    invalidateCatalogLoad();
    const generation = ++flowGeneration.current;
    const intent: LoginIntent = { generation, cancelRequested: false };
    activeLoginIntent.current = intent;
    setLoginPending(true);
    setErrorKey(null);
    try {
      const attempt = await api.startChatGptLogin();
      if (
        !mounted.current ||
        intent.cancelRequested ||
        activeLoginIntent.current !== intent ||
        generation !== flowGeneration.current
      ) {
        await api.cancelChatGptLogin(attempt.attemptId).catch(() => undefined);
        return;
      }
      loginAttempt.current = attempt.attemptId;
      await pollForSignedInAccount({
        api,
        attempt,
        isCurrent: () =>
          mounted.current &&
          !intent.cancelRequested &&
          activeLoginIntent.current === intent &&
          generation === flowGeneration.current,
        schedule: (timer, wake) => {
          loginPollWait.current = { timer, wake };
        },
      });
      if (
        !mounted.current ||
        intent.cancelRequested ||
        activeLoginIntent.current !== intent ||
        generation !== flowGeneration.current
      ) {
        return;
      }
      clearLoginWait();
      loginAttempt.current = null;
      activeLoginIntent.current = null;
      await loadCatalog(generation);
    } catch (error) {
      if (
        !mounted.current ||
        intent.cancelRequested ||
        activeLoginIntent.current !== intent ||
        generation !== flowGeneration.current
      ) {
        return;
      }
      clearLoginWait();
      const attemptId = loginAttempt.current;
      loginAttempt.current = null;
      activeLoginIntent.current = null;
      if (attemptId) await api.cancelChatGptLogin(attemptId).catch(() => undefined);
      if (!mounted.current || generation !== flowGeneration.current) return;
      setErrorKey(safeOnboardingErrorKey(asStableError(error, "CODEX_NOT_LOGGED_IN")));
    } finally {
      if (mounted.current && generation === flowGeneration.current) {
        activeLoginIntent.current = null;
        setLoginPending(false);
      }
    }
  };

  const cancelLogin = async (): Promise<void> => {
    const intent = activeLoginIntent.current;
    if (!loginPending || !intent) return;
    intent.cancelRequested = true;
    if (activeLoginIntent.current === intent) activeLoginIntent.current = null;
    invalidateCatalogLoad();
    const generation = ++flowGeneration.current;
    clearLoginWait();
    const attemptId = loginAttempt.current;
    loginAttempt.current = null;
    setLoginPending(false);
    setErrorKey(null);
    if (!attemptId) return;
    try {
      await api.cancelChatGptLogin(attemptId);
      if (mounted.current && generation === flowGeneration.current) setErrorKey(null);
    } catch {
      if (mounted.current && generation === flowGeneration.current) {
        setErrorKey("onboarding.error.CODEX_NOT_LOGGED_IN");
      }
    }
  };

  const submitOwner = async (): Promise<void> => {
    const validationKey = ownerValidationErrorKey(ownerDraft);
    if (
      activeOwnerUpdate.current !== null ||
      ownerPending ||
      ownerRevision === null ||
      validationKey !== null
    ) {
      return;
    }
    const generation = flowGeneration.current;
    const intent: OwnerUpdateIntent = {
      generation,
      requestId: ++ownerUpdateRequestId.current,
    };
    const isCurrent = (): boolean =>
      mounted.current &&
      generation === flowGeneration.current &&
      activeOwnerUpdate.current === intent;
    activeOwnerUpdate.current = intent;
    setOwnerPending(true);
    setOwnerMessageKey(null);
    setOwnerMessageIsAlert(false);
    try {
      await api.updateOwnerIdentity({
        expectedRevision: ownerRevision,
        ownerUsername: ownerDraft,
      });
      if (!isCurrent()) return;
      setStep("pcl2");
      persist({ progressHint: "pcl2" });
    } catch (error) {
      if (!isCurrent()) return;
      setOwnerMessageKey(safeOwnerErrorKey(error));
      setOwnerMessageIsAlert(true);
    } finally {
      if (activeOwnerUpdate.current === intent) {
        activeOwnerUpdate.current = null;
        if (mounted.current && generation === flowGeneration.current) setOwnerPending(false);
      }
    }
  };

  const refreshPcl2 = useCallback(async (): Promise<void> => {
    const generation = flowGeneration.current;
    setPcl2Loading(true);
    setErrorKey(null);
    try {
      const candidates = await api.discoverPcl2();
      if (!mounted.current || generation !== flowGeneration.current) return;
      setPcl2Candidates(candidates);
      if (candidates.length === 0) setErrorKey("onboarding.error.PCL2_NOT_FOUND");
      if (
        candidates.length > 0 &&
        !resumedPcl2.current &&
        (resumeHint.current === "lan" || resumeHint.current === "ready")
      ) {
        resumedPcl2.current = true;
        setStep("lan");
        lanPreservedErrorKey.current = null;
        persist({ progressHint: "lan" });
      }
    } catch (error) {
      if (!mounted.current || generation !== flowGeneration.current) return;
      setPcl2Candidates([]);
      setErrorKey(safeOnboardingErrorKey(asStableError(error, "PCL2_NOT_FOUND")));
    } finally {
      if (mounted.current && generation === flowGeneration.current) setPcl2Loading(false);
    }
  }, [api, persist]);

  useEffect(() => {
    if (step !== "pcl2") return;
    persist({ progressHint: "pcl2" });
    void refreshPcl2();
  }, [persist, refreshPcl2, step]);

  const scanLan = useCallback(
    (generation: number): Promise<readonly LanCandidate[]> => {
      if (!mounted.current || generation !== lanDiscoveryGeneration.current) {
        return Promise.resolve([]);
      }
      const pending = lanDiscoveryInFlight.current;
      if (pending?.generation === generation) return pending.promise;
      const flow = flowGeneration.current;
      const requestId = ++lanDiscoveryRequestId.current;
      const isCurrent = (): boolean =>
        mounted.current &&
        flow === flowGeneration.current &&
        generation === lanDiscoveryGeneration.current &&
        requestId === lanDiscoveryRequestId.current &&
        lanDiscoveryInFlight.current?.requestId === requestId;
      setActionRecoveryAvailable(false);
      setLanLoading(true);
      if (lanPreservedErrorKey.current === null) setErrorKey(null);
      const operation = Promise.resolve().then(async () => {
        try {
          const detectedCandidates = await api.detectLanCandidates();
          if (!isCurrent()) return [];
          const now = Date.now();
          const candidates = detectedCandidates.filter(
            (candidate) => candidate.observedAt <= now && now < candidate.expiresAt,
          );
          setLanCandidates(candidates);
          setErrorKey(
            lanPreservedErrorKey.current ??
              (candidates.length === 0 ? "onboarding.error.LAN_NOT_FOUND" : null),
          );
          return candidates;
        } catch (error) {
          if (!isCurrent()) return [];
          setLanCandidates([]);
          setErrorKey(
            lanPreservedErrorKey.current ??
              safeOnboardingErrorKey(asStableError(error, "LAN_NOT_FOUND")),
          );
          return [];
        } finally {
          if (lanDiscoveryInFlight.current?.requestId === requestId) {
            const current = isCurrent();
            lanDiscoveryInFlight.current = null;
            if (current) setLanLoading(false);
          }
        }
      });
      lanDiscoveryInFlight.current = { requestId, generation, promise: operation };
      return operation;
    },
    [api],
  );

  useEffect(() => {
    if (
      step !== "lan" ||
      connectingCandidate !== null ||
      actionRecoveryAvailable ||
      actionRetryPending
    ) {
      return;
    }
    persist({ progressHint: "lan" });
    const generation = ++lanDiscoveryGeneration.current;
    let stopped = false;
    let attempts = 0;
    const clearExpiredCandidates = (): void => {
      if (stopped || generation !== lanDiscoveryGeneration.current) return;
      const now = Date.now();
      const nextExpiry = Math.min(...lanCandidates.map((candidate) => candidate.expiresAt));
      if (lanCandidates.some((candidate) => now < candidate.observedAt) || now >= nextExpiry) {
        setLanCandidates([]);
        return;
      }
      lanPollTimer.current = setTimeout(() => {
        lanPollTimer.current = null;
        clearExpiredCandidates();
      }, nextExpiry - now);
    };
    const run = async (): Promise<void> => {
      if (stopped || generation !== lanDiscoveryGeneration.current) return;
      attempts += 1;
      const candidates = await scanLan(generation);
      if (stopped || generation !== lanDiscoveryGeneration.current || candidates.length > 0) {
        return;
      }
      lanPollTimer.current = setTimeout(
        () => {
          lanPollTimer.current = null;
          void run();
        },
        attempts >= FAST_LAN_POLL_ATTEMPTS ? LAN_IDLE_POLL_INTERVAL_MS : LAN_POLL_INTERVAL_MS,
      );
    };
    if (lanCandidates.length > 0) {
      clearExpiredCandidates();
    } else {
      void run();
    }
    return () => {
      stopped = true;
      if (lanPollTimer.current !== null) clearTimeout(lanPollTimer.current);
      lanPollTimer.current = null;
      if (lanDiscoveryGeneration.current === generation) {
        lanDiscoveryGeneration.current += 1;
        lanDiscoveryRequestId.current += 1;
        lanDiscoveryInFlight.current = null;
      }
    };
  }, [
    actionRecoveryAvailable,
    actionRetryPending,
    connectingCandidate,
    lanCandidates.length,
    lanRefreshEpoch,
    persist,
    scanLan,
    step,
  ]);

  const restartLanDiscovery = (preservedErrorKey: MessageKey | null = null): void => {
    lanPreservedErrorKey.current = preservedErrorKey;
    setLanCandidates([]);
    setLanRefreshEpoch((current) => current + 1);
  };

  useEffect(() => {
    const generation = ++componentGeneration.current;
    if (!active || step !== "lan" || lanCandidates.length === 0) {
      setComponentEntries(new Map());
      return;
    }
    const initial = new Map<string, CandidateComponentEntry>();
    for (const candidate of lanCandidates) {
      initial.set(candidate.id, {
        status: null,
        loading: true,
        pending: false,
        failed: false,
        bridgeSelected: true,
        avatarSelected: true,
      });
    }
    setComponentEntries(initial);
    for (const candidate of lanCandidates) {
      void api.getMinecraftComponentStatus(candidate.id).then(
        (status) => {
          if (
            !mounted.current ||
            generation !== componentGeneration.current ||
            Date.now() < candidate.observedAt ||
            Date.now() >= candidate.expiresAt
          ) {
            return;
          }
          setComponentEntries((current) => {
            if (generation !== componentGeneration.current || !current.has(candidate.id)) {
              return current;
            }
            const next = new Map(current);
            next.set(candidate.id, componentEntryFromStatus(status));
            return next;
          });
        },
        () => {
          if (
            !mounted.current ||
            generation !== componentGeneration.current ||
            Date.now() < candidate.observedAt ||
            Date.now() >= candidate.expiresAt
          ) {
            return;
          }
          setComponentEntries((current) => {
            if (!current.has(candidate.id)) return current;
            const next = new Map(current);
            next.set(candidate.id, {
              status: null,
              loading: false,
              pending: false,
              failed: true,
              bridgeSelected: true,
              avatarSelected: true,
            });
            return next;
          });
        },
      );
    }
    return () => {
      if (componentGeneration.current === generation) componentGeneration.current += 1;
    };
  }, [active, api, lanCandidates, step]);

  const updateComponentSelection = (
    candidateId: string,
    component: MinecraftComponentId,
    selected: boolean,
  ): void => {
    setComponentEntries((current) => {
      const entry = current.get(candidateId);
      if (!entry || entry.pending) return current;
      const next = new Map(current);
      next.set(
        candidateId,
        component === "bridge"
          ? {
              ...entry,
              bridgeSelected: selected,
              avatarSelected: selected ? entry.avatarSelected : false,
            }
          : {
              ...entry,
              avatarSelected: selected,
              bridgeSelected: selected || entry.bridgeSelected,
            },
      );
      return next;
    });
  };

  const installComponents = async (candidate: LanCandidate): Promise<void> => {
    const generation = componentGeneration.current;
    const entry = componentEntriesRef.current.get(candidate.id);
    if (!entry || entry.pending || !entry.status || isUnsupportedComponentStatus(entry.status)) {
      return;
    }
    const selection: MinecraftComponentId[] = [];
    if (entry.bridgeSelected) selection.push("bridge");
    if (entry.avatarSelected) selection.push("avatar");
    if (selection.length === 0) return;
    setComponentEntries((current) => {
      const currentEntry = current.get(candidate.id);
      if (!currentEntry) return current;
      const next = new Map(current);
      next.set(candidate.id, { ...currentEntry, pending: true, failed: false });
      return next;
    });
    try {
      const status = await api.installMinecraftComponents(candidate.id, selection);
      if (
        !mounted.current ||
        generation !== componentGeneration.current ||
        Date.now() < candidate.observedAt ||
        Date.now() >= candidate.expiresAt ||
        !lanCandidates.some((current) => current.id === candidate.id)
      ) {
        return;
      }
      setComponentEntries((current) => {
        if (!current.has(candidate.id)) return current;
        const next = new Map(current);
        next.set(candidate.id, componentEntryFromStatus(status));
        return next;
      });
    } catch {
      if (
        !mounted.current ||
        generation !== componentGeneration.current ||
        Date.now() < candidate.observedAt ||
        Date.now() >= candidate.expiresAt ||
        !lanCandidates.some((current) => current.id === candidate.id)
      ) {
        return;
      }
      setComponentEntries((current) => {
        const currentEntry = current.get(candidate.id);
        if (!currentEntry) return current;
        const next = new Map(current);
        next.set(candidate.id, { ...currentEntry, pending: false, failed: true });
        return next;
      });
    }
  };

  const confirmAndConnect = async (candidateId: string): Promise<void> => {
    if (connectingCandidate) return;
    if (!componentStatusAllowsConfirmation(componentEntriesRef.current.get(candidateId))) return;
    const generation = flowGeneration.current;
    let candidateConfirmed = false;
    setConnectingCandidate(candidateId);
    setActionRecoveryAvailable(false);
    setErrorKey(null);
    try {
      await api.confirmLanCandidate(candidateId);
      candidateConfirmed = true;
      if (!mounted.current || generation !== flowGeneration.current) return;
      const snapshot = await api.start();
      if (!mounted.current || generation !== flowGeneration.current) return;
      if (snapshot.lifecycle !== "running") throw new Error("MINECRAFT_CONNECT_FAILED");
      setStep("ready");
      persist({ progressHint: "ready" });
      onReady(snapshot);
    } catch (error) {
      if (!mounted.current || generation !== flowGeneration.current) return;
      const key = safeOnboardingErrorKey(asStableError(error, "MINECRAFT_CONNECT_FAILED"));
      setErrorKey(key);
      if (candidateConfirmed && isActionRecoveryErrorKey(key)) {
        setActionRecoveryAvailable(true);
      } else if (key === "onboarding.error.LAN_CANDIDATE_EXPIRED" || candidateConfirmed) {
        restartLanDiscovery(key);
        setErrorKey(key);
      }
    } finally {
      if (mounted.current && generation === flowGeneration.current) {
        setConnectingCandidate(null);
      }
    }
  };

  const retryActionCapability = async (): Promise<void> => {
    if (!actionRecoveryAvailable || actionRetryPending || connectingCandidate !== null) return;
    const generation = flowGeneration.current;
    setActionRetryPending(true);
    setErrorKey(null);
    try {
      const snapshot = await api.start();
      if (!mounted.current || generation !== flowGeneration.current) return;
      if (snapshot.lifecycle !== "running") throw new Error("MINECRAFT_CONNECT_FAILED");
      setActionRecoveryAvailable(false);
      setStep("ready");
      persist({ progressHint: "ready" });
      onReady(snapshot);
    } catch (error) {
      if (!mounted.current || generation !== flowGeneration.current) return;
      const key = safeOnboardingErrorKey(asStableError(error, "MINECRAFT_CONNECT_FAILED"));
      setErrorKey(key);
      if (!isActionRecoveryErrorKey(key)) {
        setActionRecoveryAvailable(false);
        restartLanDiscovery(key);
        setErrorKey(key);
      }
    } finally {
      if (mounted.current && generation === flowGeneration.current) setActionRetryPending(false);
    }
  };

  const connectionLifecycle =
    connectingCandidate !== null
      ? "connecting"
      : lanLoading
        ? "detecting"
        : lanCandidates.length > 0
          ? "awaiting_confirmation"
          : "idle";
  const ownerValidationKey = ownerValidationErrorKey(ownerDraft);
  const visibleOwnerMessageKey =
    ownerMessageKey ?? (ownerDraft.length > 0 ? ownerValidationKey : null);
  const ownerCanSubmit =
    ownerRevision !== null &&
    ownerValidationKey === null &&
    !ownerPending &&
    activeOwnerUpdate.current === null;

  return (
    <main className="onboarding" data-connection-lifecycle={connectionLifecycle}>
      <OnboardingProgress locale={locale} step={step} />
      <section className="onboarding-panel" aria-labelledby="onboarding-title">
        {step === "environment" ? (
          <>
            <p className="onboarding-eyebrow">{translate(locale, "onboarding.eyebrow")}</p>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.environment.title")}
            </h1>
            <p>{translate(locale, "onboarding.environment.body")}</p>
            <div className="onboarding-loading" role="status" aria-live="polite">
              <span className="loading-spinner" aria-hidden="true" />
              {translate(locale, "onboarding.environment.loading")}
            </div>
          </>
        ) : null}

        {step === "login" ? (
          <>
            <p className="onboarding-eyebrow">{translate(locale, "onboarding.eyebrow")}</p>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.login.title")}
            </h1>
            <p>{translate(locale, "onboarding.login.body")}</p>
            <div className="onboarding-actions">
              <button
                className="primary-button"
                type="button"
                disabled={loginPending}
                onClick={() => void startLogin()}
              >
                {translate(
                  locale,
                  loginPending ? "onboarding.login.waiting" : "onboarding.login.start",
                )}
              </button>
              {loginPending ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void cancelLogin()}
                >
                  {translate(locale, "onboarding.login.cancel")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {step === "model" ? (
          <>
            <p className="onboarding-eyebrow">{translate(locale, "onboarding.eyebrow")}</p>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.model.title")}
            </h1>
            <p>{translate(locale, "onboarding.model.body")}</p>
            {catalog && catalog.models.length > 0 ? (
              <ModelPicker
                locale={locale}
                catalog={catalog}
                onSelect={(selection) => api.selectModel(selection)}
                onApplied={(selection) => {
                  setErrorKey(null);
                  setCatalog((current) => (current ? { ...current, selection } : current));
                }}
                onContinue={() => {
                  void loadOwnerIdentity(flowGeneration.current);
                }}
              />
            ) : (
              <button
                className="secondary-button"
                type="button"
                disabled={catalogLoading}
                onClick={() => void loadCatalog(flowGeneration.current)}
              >
                {translate(locale, catalogLoading ? "onboarding.refreshing" : "onboarding.retry")}
              </button>
            )}
          </>
        ) : null}

        {step === "owner" ? (
          <>
            <p className="onboarding-eyebrow">{translate(locale, "onboarding.eyebrow")}</p>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.owner.title")}
            </h1>
            <p>{translate(locale, "onboarding.owner.body")}</p>
            <form
              className="owner-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitOwner();
              }}
            >
              <label htmlFor="owner-username">{translate(locale, "onboarding.owner.label")}</label>
              <input
                id="owner-username"
                autoComplete="off"
                spellCheck={false}
                minLength={3}
                maxLength={16}
                pattern="[A-Za-z0-9_]{3,16}"
                value={ownerDraft}
                disabled={ownerRevision === null}
                aria-invalid={visibleOwnerMessageKey !== null}
                aria-describedby="owner-help owner-error"
                onChange={(event) => {
                  setOwnerDraft(event.target.value);
                  if (ownerRevision !== null) {
                    setOwnerMessageKey(null);
                    setOwnerMessageIsAlert(false);
                  }
                }}
              />
              <p id="owner-help" className="owner-form__help">
                {translate(locale, "onboarding.owner.help")}
              </p>
              <p
                id="owner-error"
                className="owner-form__error"
                ref={ownerAlert}
                role={ownerMessageIsAlert ? "alert" : undefined}
                aria-live={ownerMessageIsAlert ? "assertive" : undefined}
                tabIndex={ownerMessageIsAlert ? -1 : undefined}
              >
                {visibleOwnerMessageKey ? translate(locale, visibleOwnerMessageKey) : null}
              </p>
              <button className="primary-button" type="submit" disabled={!ownerCanSubmit}>
                {translate(
                  locale,
                  ownerPending ? "onboarding.owner.pending" : "onboarding.owner.confirm",
                )}
              </button>
            </form>
          </>
        ) : null}

        {step === "pcl2" ? (
          <>
            <p className="onboarding-eyebrow">{translate(locale, "onboarding.eyebrow")}</p>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.pcl2.title")}
            </h1>
            <p>{translate(locale, "onboarding.pcl2.body")}</p>
            {pcl2Candidates.length > 0 ? (
              <ul className="pcl2-list">
                {pcl2Candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <span>{candidate.displayPath}</span>
                    <span>
                      {translate(
                        locale,
                        candidate.running ? "onboarding.pcl2.running" : "onboarding.pcl2.installed",
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {pcl2Candidates.length === 0 && !pcl2Loading ? (
              <div className="instruction-card">
                <strong>{translate(locale, "onboarding.pcl2.notFoundTitle")}</strong>
                <p>{translate(locale, "onboarding.pcl2.notFoundBody")}</p>
              </div>
            ) : null}
            <div className="onboarding-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={pcl2Loading}
                onClick={() => void refreshPcl2()}
              >
                {translate(locale, pcl2Loading ? "onboarding.refreshing" : "onboarding.refresh")}
              </button>
              {pcl2Candidates.length > 0 ? (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    lanPreservedErrorKey.current = null;
                    setStep("lan");
                    persist({ progressHint: "lan" });
                  }}
                >
                  {translate(locale, "onboarding.pcl2.continue")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {step === "lan" ? (
          <>
            <p className="onboarding-eyebrow">{translate(locale, "onboarding.eyebrow")}</p>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.lan.title")}
            </h1>
            <p>{translate(locale, "onboarding.lan.body")}</p>
            <div className="instruction-card">
              <strong>{translate(locale, "onboarding.lan.instructionsTitle")}</strong>
              <p>{translate(locale, "onboarding.lan.instructionsBody")}</p>
            </div>
            {lanCandidates.length > 0 ? (
              <div className="lan-candidate-list">
                {lanCandidates.map((candidate) => (
                  <div className="minecraft-component-candidate" key={candidate.id}>
                    <LanCandidateCard
                      candidate={candidate}
                      locale={locale}
                      pending={connectingCandidate === candidate.id}
                      disabled={
                        connectingCandidate !== null ||
                        actionRecoveryAvailable ||
                        actionRetryPending ||
                        !componentStatusAllowsConfirmation(componentEntries.get(candidate.id))
                      }
                      onConfirm={(id) => void confirmAndConnect(id)}
                    />
                    <CandidateComponentControls
                      entry={componentEntries.get(candidate.id)}
                      locale={locale}
                      onSelectionChange={(component, selected) =>
                        updateComponentSelection(candidate.id, component, selected)
                      }
                      onInstall={() => void installComponents(candidate)}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            <button
              className="secondary-button"
              type="button"
              disabled={
                lanLoading ||
                connectingCandidate !== null ||
                actionRecoveryAvailable ||
                actionRetryPending
              }
              onClick={() => restartLanDiscovery()}
            >
              {translate(locale, lanLoading ? "onboarding.refreshing" : "onboarding.refresh")}
            </button>
            {actionRecoveryAvailable ? (
              <button
                className="primary-button"
                type="button"
                disabled={actionRetryPending}
                onClick={() => void retryActionCapability()}
              >
                {translate(locale, "onboarding.action.retry")}
              </button>
            ) : null}
          </>
        ) : null}

        {step === "ready" ? (
          <>
            <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
              {translate(locale, "onboarding.ready.title")}
            </h1>
            <p>{translate(locale, "onboarding.ready.body")}</p>
          </>
        ) : null}

        {errorKey ? (
          <p className="onboarding-error" role="alert" aria-live="assertive">
            {translate(locale, errorKey)}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function CandidateComponentControls({
  entry,
  locale,
  onSelectionChange,
  onInstall,
}: {
  readonly entry: CandidateComponentEntry | undefined;
  readonly locale: Locale;
  readonly onSelectionChange: (component: MinecraftComponentId, selected: boolean) => void;
  readonly onInstall: () => void;
}) {
  if (!entry || entry.loading) {
    return <p role="status">{translate(locale, "minecraft.components.checking")}</p>;
  }
  const supported = entry.status ? !isUnsupportedComponentStatus(entry.status) : false;
  const installable =
    supported &&
    (entry.status?.state === "bridge_not_installed" ||
      (entry.status?.state === "bridge_version_unsupported" && entry.status.bridgeInstalled) ||
      entry.status?.state === "avatar_not_installed");
  return (
    <section className="minecraft-component-controls">
      <h3>{translate(locale, "minecraft.components.title")}</h3>
      {supported ? (
        <>
          <p>{translate(locale, "minecraft.components.verifiedInstance")}</p>
          <p>{translate(locale, "minecraft.components.scope")}</p>
          <p>{translate(locale, "minecraft.components.worldsUnchanged")}</p>
        </>
      ) : null}
      {entry.status ? (
        <p role="status">{translate(locale, componentStatusMessageKey(entry.status))}</p>
      ) : null}
      {entry.failed ? (
        <p role="alert">{translate(locale, "minecraft.components.operationFailed")}</p>
      ) : null}
      {installable ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={entry.bridgeSelected}
              disabled={entry.pending}
              onChange={(event) => onSelectionChange("bridge", event.target.checked)}
            />
            {translate(locale, "minecraft.components.bridge")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={entry.avatarSelected}
              disabled={entry.pending}
              onChange={(event) => onSelectionChange("avatar", event.target.checked)}
            />
            {translate(locale, "minecraft.components.avatar")}
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={entry.pending || (!entry.bridgeSelected && !entry.avatarSelected)}
            onClick={onInstall}
          >
            {translate(
              locale,
              entry.pending ? "minecraft.components.installing" : "minecraft.components.install",
            )}
          </button>
        </>
      ) : null}
    </section>
  );
}

function componentEntryFromStatus(status: MinecraftComponentStatus): CandidateComponentEntry {
  return {
    status,
    loading: false,
    pending: false,
    failed: false,
    bridgeSelected:
      !status.bridgeInstalled ||
      !status.avatarInstalled ||
      status.state === "bridge_version_unsupported",
    avatarSelected: !status.avatarInstalled,
  };
}

function componentStatusAllowsConfirmation(entry: CandidateComponentEntry | undefined): boolean {
  return (
    entry?.status !== null &&
    entry?.status !== undefined &&
    !entry.loading &&
    !entry.pending &&
    !entry.failed &&
    !entry.status.restartRequired &&
    entry.status.bridgeActive &&
    (entry.status.state === "ready" || entry.status.state === "avatar_not_installed")
  );
}

function componentStatusMessageKey(status: MinecraftComponentStatus): MessageKey {
  if (isUnsupportedComponentStatus(status)) {
    return "minecraft.components.state.instance_unsupported";
  }
  switch (status.state) {
    case "bridge_not_installed":
      return "minecraft.components.state.bridge_not_installed";
    case "bridge_restart_required":
      return "minecraft.components.state.bridge_restart_required";
    case "bridge_not_active":
      return "minecraft.components.state.bridge_not_active";
    case "bridge_version_unsupported":
      return "minecraft.components.state.bridge_version_unsupported";
    case "bridge_file_conflict":
      return "minecraft.components.state.bridge_file_conflict";
    case "avatar_not_installed":
      return "minecraft.components.state.avatar_not_installed";
    case "avatar_restart_required":
      return "minecraft.components.state.avatar_restart_required";
    case "ready":
      return "minecraft.components.state.ready";
  }
}

function isUnsupportedComponentStatus(status: MinecraftComponentStatus): boolean {
  return status.state === "bridge_version_unsupported" && !status.bridgeInstalled;
}

export function readOnboardingLocale(): Locale {
  return readOnboardingPreferences().preferences.locale;
}

export function persistOnboardingLocale(locale: Locale): void {
  const current = readOnboardingPreferences();
  const next = { ...current.preferences, locale };
  if (current.legacyMigrationPending) {
    writeLegacyOnboardingPreferences(next, current.legacyModelCandidate);
  } else {
    writeOnboardingPreferences(next);
  }
}

export function safeOnboardingErrorKey(error: unknown): MessageKey {
  const message = error instanceof Error ? error.message : "";
  const mappings: readonly [string, MessageKey][] = [
    ["CODEX_NOT_LOGGED_IN", "onboarding.error.CODEX_NOT_LOGGED_IN"],
    ["MODEL_UNAVAILABLE", "onboarding.error.MODEL_UNAVAILABLE"],
    ["PCL2_NOT_FOUND", "onboarding.error.PCL2_NOT_FOUND"],
    ["LAN_NOT_FOUND", "onboarding.error.LAN_NOT_FOUND"],
    ["LAN_CANDIDATE_EXPIRED", "onboarding.error.LAN_CANDIDATE_EXPIRED"],
    ["LAN_CANDIDATE_CHANGED", "onboarding.error.LAN_CANDIDATE_EXPIRED"],
    ["MINECRAFT_VERSION_UNVERIFIED", "onboarding.error.MINECRAFT_VERSION_UNVERIFIED"],
    ["MINECRAFT_CONNECT_FAILED", "onboarding.error.MINECRAFT_CONNECT_FAILED"],
    ["WORKSPACE_RESOURCE_INVALID", "onboarding.error.WORKSPACE_RESOURCE_INVALID"],
    ["WORKSPACE_DEPLOY_FAILED", "onboarding.error.WORKSPACE_DEPLOY_FAILED"],
    ["MCP_PORT_UNAVAILABLE", "onboarding.error.MCP_PORT_UNAVAILABLE"],
    ["MCP_TOOL_CATALOG_INVALID", "onboarding.error.MCP_TOOL_CATALOG_INVALID"],
    ["MCP_READINESS_TIMEOUT", "onboarding.error.MCP_READINESS_TIMEOUT"],
  ];
  return mappings.find(([code]) => message.includes(code))?.[1] ?? "onboarding.error.UNKNOWN";
}

function isActionRecoveryErrorKey(key: MessageKey): boolean {
  return (
    key === "onboarding.error.WORKSPACE_RESOURCE_INVALID" ||
    key === "onboarding.error.WORKSPACE_DEPLOY_FAILED" ||
    key === "onboarding.error.MCP_PORT_UNAVAILABLE" ||
    key === "onboarding.error.MCP_TOOL_CATALOG_INVALID" ||
    key === "onboarding.error.MCP_READINESS_TIMEOUT"
  );
}

function ownerValidationErrorKey(value: string): MessageKey | null {
  try {
    parseMinecraftJavaUsername(value);
    return null;
  } catch {
    return value.trim().toLowerCase() === "whitelily"
      ? "onboarding.owner.error.collision"
      : "onboarding.owner.error.invalid";
  }
}

function safeOwnerErrorKey(error: unknown): MessageKey {
  const message = error instanceof Error ? error.message : "";
  const mappings: readonly [string, MessageKey][] = [
    ["OWNER_IDENTITY_INVALID", "onboarding.owner.error.invalid"],
    ["OWNER_IDENTITY_REQUIRED", "onboarding.owner.error.invalid"],
    ["OWNER_IDENTITY_CONFIG_CONFLICT", "onboarding.owner.error.stale"],
    ["OWNER_IDENTITY_WRITE_FAILED", "onboarding.owner.error.write"],
    ["OWNER_IDENTITY_CONFIG_INVALID", "onboarding.owner.error.configInvalid"],
  ];
  return (
    mappings.find(([code]) => message.includes(code))?.[1] ?? "onboarding.owner.error.unavailable"
  );
}

async function pollForSignedInAccount(options: {
  api: WhiteLilyDesktopApi;
  attempt: Extract<AccountSnapshot, { status: "pending" }>;
  isCurrent(): boolean;
  schedule(timer: ReturnType<typeof setTimeout>, wake: () => void): void;
}): Promise<void> {
  const deadline = Math.min(options.attempt.expiresAt, Date.now() + MAX_LOGIN_POLL_MS);
  while (options.isCurrent() && Date.now() < deadline) {
    const account = await options.api.getAccount();
    if (isSignedIn(account)) return;
    if (account.status === "cancelled" || account.status === "expired") {
      throw new Error("CODEX_NOT_LOGGED_IN");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOGIN_POLL_INTERVAL_MS);
      options.schedule(timer, resolve);
    });
  }
  throw new Error("CODEX_NOT_LOGGED_IN");
}

function isSignedIn(
  account: AccountSnapshot,
): account is Extract<AccountSnapshot, { status: "signed_in" }> {
  return account.status === "signed_in" && account.auth === "chatgpt";
}

function asStableError(error: unknown, fallbackCode: string): Error {
  if (error instanceof Error && safeOnboardingErrorKey(error) !== "onboarding.error.UNKNOWN") {
    return error;
  }
  return new Error(fallbackCode);
}

function readOnboardingPreferences(): ReadOnboardingPreferencesResult {
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) {
      return {
        preferences: { ...defaultPreferences },
        legacyMigrationPending: false,
        legacyModelCandidate: null,
      };
    }
    if (raw.length > MAX_STORAGE_BYTES) throw new Error("oversized onboarding preferences");
    const parsed: unknown = JSON.parse(raw);
    if (isSafePreferences(parsed)) {
      return {
        preferences: parsed,
        legacyMigrationPending: false,
        legacyModelCandidate: null,
      };
    }
    const legacy = readLegacyPreferences(parsed);
    if (!legacy) throw new Error("invalid onboarding preferences");
    return legacy;
  } catch {
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; onboarding remains live-authority driven.
    }
    return {
      preferences: { ...defaultPreferences },
      legacyMigrationPending: false,
      legacyModelCandidate: null,
    };
  }
}

function writeOnboardingPreferences(preferences: SafePreferences): void {
  try {
    const raw = JSON.stringify(preferences);
    if (raw.length > MAX_STORAGE_BYTES) throw new Error("oversized onboarding preferences");
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, raw);
  } catch {
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Storage is an optional UI-resume hint, never runtime authority.
    }
  }
}

function writeLegacyOnboardingPreferences(
  preferences: SafePreferences,
  modelPreference: ModelSelectionInput | null,
): void {
  try {
    const raw = JSON.stringify({
      version: 2,
      locale: preferences.locale,
      progressHint: preferences.progressHint,
      modelPreference,
    });
    if (raw.length > MAX_STORAGE_BYTES) throw new Error("oversized onboarding preferences");
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, raw);
  } catch {
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Optional resume state can be dropped when storage is unavailable.
    }
  }
}

function isSafePreferences(value: unknown): value is SafePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "locale,progressHint,version" ||
    record.version !== STORAGE_VERSION ||
    !(record.locale === "zh-CN" || record.locale === "en") ||
    !(
      record.progressHint === "login" ||
      record.progressHint === "model" ||
      record.progressHint === "owner" ||
      record.progressHint === "pcl2" ||
      record.progressHint === "lan" ||
      record.progressHint === "ready"
    )
  ) {
    return false;
  }
  return true;
}

function readLegacyPreferences(value: unknown): ReadOnboardingPreferencesResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "locale,modelPreference,progressHint,version" ||
    !(record.version === 1 || record.version === 2) ||
    !(record.locale === "zh-CN" || record.locale === "en") ||
    !(
      record.progressHint === "login" ||
      record.progressHint === "model" ||
      record.progressHint === "owner" ||
      record.progressHint === "pcl2" ||
      record.progressHint === "lan" ||
      record.progressHint === "ready"
    ) ||
    !isSafeModelPreference(record.modelPreference)
  ) {
    return null;
  }
  return {
    preferences: {
      version: STORAGE_VERSION,
      locale: record.locale,
      progressHint:
        record.version === 1 && record.progressHint !== "login" && record.progressHint !== "model"
          ? "owner"
          : record.progressHint,
    },
    legacyMigrationPending: true,
    legacyModelCandidate: record.modelPreference,
  };
}

function isSafeModelPreference(value: unknown): value is ModelSelectionInput | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const preference = value as Record<string, unknown>;
  if (preference.mode === "automatic") {
    return Object.keys(preference).join(",") === "mode";
  }
  return (
    Object.keys(preference).sort().join(",") === "mode,modelId,reasoningEffort" &&
    preference.mode === "explicit" &&
    typeof preference.modelId === "string" &&
    MODEL_ID_PATTERN.test(preference.modelId) &&
    typeof preference.reasoningEffort === "string" &&
    EFFORT_PATTERN.test(preference.reasoningEffort)
  );
}
