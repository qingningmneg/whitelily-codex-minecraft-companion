import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  parseMinecraftJavaUsername,
  type OwnerIdentitySnapshot,
} from "../../../../src/identity/ownerIdentity.js";
import type { WhiteLilyAppApi } from "../desktopApi.js";
import type {
  MinecraftComponentId,
  MinecraftComponentStatus,
} from "../../src-main/minecraftComponents.js";
import type { Locale, MessageKey } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";
import { DocumentConflictNotice } from "../components/DocumentConflictNotice.js";

interface SettingsPageProps {
  api: Pick<
    WhiteLilyAppApi,
    | "readStartupSetting"
    | "setStartupSetting"
    | "readCloseToTraySetting"
    | "setCloseToTraySetting"
    | "readOwnerIdentity"
    | "updateOwnerIdentity"
    | "detectLanCandidates"
    | "getMinecraftComponentStatus"
    | "installMinecraftComponents"
    | "removeMinecraftComponents"
  >;
  locale: Locale;
  ownerIdentity: OwnerIdentitySnapshot | null;
  ownerStateUnknown: boolean;
  onOwnerIdentityChange(snapshot: OwnerIdentitySnapshot): boolean;
  onOwnerStateUnknownChange(unknown: boolean): void;
  onOwnerDialogOpenChange(open: boolean): void;
  onLocaleChange(locale: Locale): void;
}

interface OwnerReview {
  readonly expectedRevision: number;
  readonly oldOwner: string;
  readonly newOwner: string;
}

interface OwnerUpdateIntent {
  readonly id: number;
  readonly review: OwnerReview;
}

export function SettingsPage({
  api,
  locale,
  ownerIdentity,
  ownerStateUnknown,
  onOwnerIdentityChange,
  onOwnerStateUnknownChange,
  onOwnerDialogOpenChange,
  onLocaleChange,
}: SettingsPageProps) {
  const [startup, setStartup] = useState<{ enabled: boolean; available: boolean } | null>(null);
  const [closeToTray, setCloseToTray] = useState<{ revision: number; enabled: boolean } | null>(
    null,
  );
  const [closeDraft, setCloseDraft] = useState<boolean | null>(null);
  const [closeConflict, setCloseConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [componentStatus, setComponentStatus] = useState<MinecraftComponentStatus | null>(null);
  const [componentLoading, setComponentLoading] = useState(true);
  const [componentPending, setComponentPending] = useState(false);
  const [componentFailed, setComponentFailed] = useState(false);
  const [ownerDraft, setOwnerDraft] = useState(ownerIdentity?.ownerUsername ?? "");
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [ownerReview, setOwnerReview] = useState<OwnerReview | null>(null);
  const componentSupported =
    componentStatus !== null && !isUnsupportedComponentStatus(componentStatus);
  const [ownerPending, setOwnerPending] = useState(false);
  const [ownerRefreshPending, setOwnerRefreshPending] = useState(false);
  const ownerPendingRef = useRef(false);
  const ownerAuthorityRef = useRef(ownerIdentity);
  ownerAuthorityRef.current = ownerIdentity;
  const ownerUpdateSequence = useRef(0);
  const activeOwnerUpdate = useRef<OwnerUpdateIntent | null>(null);
  const previousOwnerUsername = useRef(ownerIdentity?.ownerUsername);
  const ownerInput = useRef<HTMLInputElement>(null);
  const switchOwnerButton = useRef<HTMLButtonElement>(null);
  const confirmOwnerButton = useRef<HTMLButtonElement>(null);
  const cancelOwnerButton = useRef<HTMLButtonElement>(null);
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const ownerReturnFocus = useRef<HTMLElement | null>(null);
  const componentGeneration = useRef(0);

  const restoreOwnerFocus = useCallback((): void => {
    const requestedTarget = ownerReturnFocus.current;
    ownerReturnFocus.current = null;
    window.setTimeout(() => {
      if (
        requestedTarget?.isConnected &&
        !("disabled" in requestedTarget && requestedTarget.disabled)
      ) {
        requestedTarget.focus();
        return;
      }
      if (ownerInput.current?.isConnected && !ownerInput.current.disabled) {
        ownerInput.current.focus();
        return;
      }
      settingsHeading.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    const previousUsername = previousOwnerUsername.current;
    if (ownerIdentity?.configured && ownerIdentity.ownerUsername) {
      setOwnerDraft((current) =>
        !previousUsername || current === previousUsername ? ownerIdentity.ownerUsername! : current,
      );
    }
    if (ownerReview && !ownerMatchesReview(ownerIdentity, ownerReview)) {
      const intent = activeOwnerUpdate.current;
      if (intent?.review === ownerReview && ownerAcknowledgesUpdate(ownerIdentity, intent)) {
        activeOwnerUpdate.current = null;
        ownerPendingRef.current = false;
        setOwnerPending(false);
        setOwnerDraft(ownerIdentity.ownerUsername);
        setOwnerTouched(false);
        setOwnerReview(null);
        setMessage(translate(locale, "settings.ownerSuccess"));
        restoreOwnerFocus();
        previousOwnerUsername.current = ownerIdentity.ownerUsername;
        return;
      }
      activeOwnerUpdate.current = null;
      ownerPendingRef.current = false;
      setOwnerPending(false);
      setOwnerReview(null);
      setMessage(translate(locale, "settings.ownerConflict"));
      restoreOwnerFocus();
    }
    previousOwnerUsername.current = ownerIdentity?.ownerUsername;
  }, [locale, ownerIdentity, ownerReview, restoreOwnerFocus]);

  useEffect(() => {
    if (ownerReview) confirmOwnerButton.current?.focus();
  }, [ownerReview]);

  useLayoutEffect(() => {
    onOwnerDialogOpenChange(ownerReview !== null);
  }, [onOwnerDialogOpenChange, ownerReview]);

  useLayoutEffect(
    () => () => {
      onOwnerDialogOpenChange(false);
    },
    [onOwnerDialogOpenChange],
  );

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const [startupSetting, closeSetting] = await Promise.all([
        api.readStartupSetting(),
        api.readCloseToTraySetting(),
      ]);
      setStartup(startupSetting);
      setCloseToTray(closeSetting);
      setCloseDraft(closeSetting.enabled);
    } catch {
      setMessage(translate(locale, "settings.error"));
    }
  }, [api, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const freshComponentCandidate = useCallback(async () => {
    const candidates = await api.detectLanCandidates();
    const now = Date.now();
    return candidates.find(
      (candidate) =>
        candidate.version === "1.21.5" && candidate.observedAt <= now && now < candidate.expiresAt,
    );
  }, [api]);

  const refreshComponents = useCallback(async (): Promise<void> => {
    const generation = ++componentGeneration.current;
    setComponentLoading(true);
    setComponentStatus(null);
    setComponentFailed(false);
    try {
      const candidate = await freshComponentCandidate();
      if (generation !== componentGeneration.current) return;
      if (!candidate) {
        setComponentStatus(null);
        return;
      }
      const status = await api.getMinecraftComponentStatus(candidate.id);
      if (generation !== componentGeneration.current) return;
      setComponentStatus(status);
    } catch {
      if (generation !== componentGeneration.current) return;
      setComponentStatus(null);
      setComponentFailed(true);
    } finally {
      if (generation === componentGeneration.current) setComponentLoading(false);
    }
  }, [api, freshComponentCandidate]);

  useEffect(() => {
    void refreshComponents();
    return () => {
      componentGeneration.current += 1;
    };
  }, [refreshComponents]);

  const mutateComponents = async (
    operation: "install" | "remove",
    selection: readonly MinecraftComponentId[],
  ): Promise<void> => {
    if (componentPending) return;
    const generation = ++componentGeneration.current;
    setComponentPending(true);
    setComponentStatus(null);
    setComponentFailed(false);
    try {
      const candidate = await freshComponentCandidate();
      if (generation !== componentGeneration.current) return;
      if (!candidate) throw new Error("candidate unavailable");
      const status = await (operation === "install"
        ? api.installMinecraftComponents(candidate.id, selection)
        : api.removeMinecraftComponents(candidate.id, selection));
      if (generation !== componentGeneration.current) return;
      setComponentStatus(status);
    } catch {
      if (generation !== componentGeneration.current) return;
      setComponentFailed(true);
    } finally {
      if (generation === componentGeneration.current) setComponentPending(false);
    }
  };

  const updateStartup = async (enabled: boolean): Promise<void> => {
    setPending(true);
    try {
      setStartup(await api.setStartupSetting(enabled));
    } catch {
      setMessage(translate(locale, "settings.error"));
    } finally {
      setPending(false);
    }
  };
  const updateCloseToTray = async (enabled: boolean, reapplying = false): Promise<void> => {
    if (!closeToTray) return;
    setCloseDraft(enabled);
    setPending(true);
    try {
      const next = await api.setCloseToTraySetting({
        expectedRevision: closeToTray.revision,
        enabled,
      });
      setCloseToTray(next);
      setCloseDraft(next.enabled);
      setCloseConflict(false);
    } catch (error) {
      if (isDocumentConflict(error)) {
        try {
          setCloseToTray(await api.readCloseToTraySetting());
          setCloseConflict(true);
        } catch {
          setMessage(translate(locale, "settings.error"));
        }
      } else {
        setMessage(translate(locale, "settings.error"));
        if (!reapplying) setCloseDraft(closeToTray.enabled);
      }
    } finally {
      setPending(false);
    }
  };

  const parsedOwnerDraft = parseOwnerDraft(ownerDraft);
  const ownerIsNoop =
    parsedOwnerDraft !== null && parsedOwnerDraft === ownerIdentity?.ownerUsername;
  const ownerIsInvalid = ownerTouched && parsedOwnerDraft === null;
  const canReviewOwner =
    ownerIdentity?.configured === true &&
    ownerIdentity.ownerUsername !== null &&
    parsedOwnerDraft !== null &&
    !ownerIsNoop &&
    !ownerPending &&
    !ownerStateUnknown;

  const reviewOwnerSwitch = (): void => {
    if (
      !canReviewOwner ||
      !ownerIdentity?.configured ||
      !ownerIdentity.ownerUsername ||
      parsedOwnerDraft === null
    ) {
      return;
    }
    setMessage(null);
    ownerReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOwnerReview({
      expectedRevision: ownerIdentity.revision,
      oldOwner: ownerIdentity.ownerUsername,
      newOwner: parsedOwnerDraft,
    });
  };

  const cancelOwnerSwitch = (): void => {
    if (ownerPendingRef.current) return;
    setOwnerReview(null);
    restoreOwnerFocus();
  };

  const confirmOwnerSwitch = async (): Promise<void> => {
    const review = ownerReview;
    if (!review || ownerPendingRef.current) return;
    if (!ownerMatchesReview(ownerAuthorityRef.current, review)) {
      setOwnerReview(null);
      setMessage(translate(locale, "settings.ownerConflict"));
      restoreOwnerFocus();
      return;
    }
    const intent: OwnerUpdateIntent = {
      id: ++ownerUpdateSequence.current,
      review,
    };
    activeOwnerUpdate.current = intent;
    ownerPendingRef.current = true;
    setOwnerPending(true);
    setMessage(null);
    try {
      const updated = await api.updateOwnerIdentity({
        expectedRevision: review.expectedRevision,
        ownerUsername: review.newOwner,
      });
      if (
        activeOwnerUpdate.current !== intent ||
        !ownerMatchesReview(ownerAuthorityRef.current, review)
      ) {
        return;
      }
      if (!ownerAcknowledgesUpdate(updated, intent)) {
        throw new Error("owner update response does not acknowledge the pending request");
      }
      activeOwnerUpdate.current = null;
      if (!onOwnerIdentityChange(updated)) {
        setOwnerReview(null);
        setMessage(null);
        onOwnerStateUnknownChange(true);
        restoreOwnerFocus();
        return;
      }
      setOwnerDraft(updated.ownerUsername ?? review.newOwner);
      setOwnerTouched(false);
      setOwnerReview(null);
      setMessage(translate(locale, "settings.ownerSuccess"));
      restoreOwnerFocus();
    } catch (error) {
      if (
        activeOwnerUpdate.current !== intent ||
        !ownerMatchesReview(ownerAuthorityRef.current, review)
      ) {
        return;
      }
      setOwnerReview(null);
      restoreOwnerFocus();
      try {
        const current = await api.readOwnerIdentity();
        if (
          activeOwnerUpdate.current !== intent ||
          !ownerMatchesReview(ownerAuthorityRef.current, review)
        ) {
          return;
        }
        activeOwnerUpdate.current = null;
        if (!onOwnerIdentityChange(current)) {
          setMessage(null);
          onOwnerStateUnknownChange(true);
          return;
        }
        if (ownerAcknowledgesUpdate(current, intent)) {
          setOwnerDraft(current.ownerUsername);
          setOwnerTouched(false);
          setMessage(translate(locale, "settings.ownerSuccess"));
        } else if (ownerMatchesReview(current, review)) {
          setMessage(translate(locale, "settings.ownerError"));
        } else {
          setMessage(translate(locale, "settings.ownerConflict"));
        }
      } catch {
        if (activeOwnerUpdate.current !== intent) return;
        activeOwnerUpdate.current = null;
        setMessage(null);
        onOwnerStateUnknownChange(true);
      }
    } finally {
      if (activeOwnerUpdate.current === intent || activeOwnerUpdate.current === null) {
        activeOwnerUpdate.current = null;
        ownerPendingRef.current = false;
        setOwnerPending(false);
      }
    }
  };

  const refreshOwnerIdentity = async (): Promise<void> => {
    if (ownerRefreshPending) return;
    setOwnerRefreshPending(true);
    try {
      const current = await api.readOwnerIdentity();
      if (!onOwnerIdentityChange(current)) {
        setMessage(null);
        onOwnerStateUnknownChange(true);
        return;
      }
      setMessage(null);
      setOwnerDraft(current.ownerUsername ?? "");
      setOwnerTouched(false);
    } catch {
      setMessage(null);
      onOwnerStateUnknownChange(true);
    } finally {
      setOwnerRefreshPending(false);
    }
  };

  const handleOwnerDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && !ownerPendingRef.current) {
      event.preventDefault();
      cancelOwnerSwitch();
      return;
    }
    if (event.key !== "Tab" || ownerPendingRef.current) return;
    const first = confirmOwnerButton.current;
    const last = cancelOwnerButton.current;
    if (!first || !last) return;
    if (!event.currentTarget.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <main className="content-page">
      <div
        className="settings-page-content"
        inert={ownerReview ? true : undefined}
        aria-hidden={ownerReview ? true : undefined}
      >
        <header className="page-header">
          <p className="page-eyebrow">{translate(locale, "settings.eyebrow")}</p>
          <h1 ref={settingsHeading} tabIndex={-1}>
            {translate(locale, "settings.title")}
          </h1>
          <p>{translate(locale, "settings.subtitle")}</p>
        </header>
        {message ? (
          <p className="page-message" role="alert">
            {message}
          </p>
        ) : null}
        {closeConflict ? (
          <DocumentConflictNotice
            locale={locale}
            changedFields={["closeToTray"]}
            pending={pending}
            onReapply={() => void updateCloseToTray(closeDraft ?? true, true)}
          />
        ) : null}
        {ownerStateUnknown ? (
          <section className="settings-card owner-settings">
            <h2>{translate(locale, "settings.ownerIdentity")}</h2>
            <p role="alert">{translate(locale, "settings.ownerUnknown")}</p>
            <button
              className="primary-button"
              type="button"
              disabled={ownerRefreshPending}
              onClick={() => void refreshOwnerIdentity()}
            >
              {translate(
                locale,
                ownerRefreshPending ? "settings.ownerRefreshing" : "settings.ownerRefresh",
              )}
            </button>
          </section>
        ) : ownerIdentity?.configured && ownerIdentity.ownerUsername ? (
          <section className="settings-card owner-settings">
            <h2>{translate(locale, "settings.ownerIdentity")}</h2>
            <div className="owner-settings__current">
              <span>{translate(locale, "settings.currentOwner")}</span>
              <strong>{ownerIdentity.ownerUsername}</strong>
              <span className="owner-settings__presence">
                {translate(
                  locale,
                  ownerIdentity.presence === "online"
                    ? "owner.online"
                    : ownerIdentity.presence === "offline"
                      ? "owner.offline"
                      : "owner.waitingState",
                )}
              </span>
            </div>
            {ownerIdentity.presence !== "online" ? (
              <p className="owner-settings__waiting">{translate(locale, "owner.waiting")}</p>
            ) : null}
            <label className="owner-settings__field">
              <span>{translate(locale, "settings.ownerNewLabel")}</span>
              <input
                ref={ownerInput}
                value={ownerDraft}
                maxLength={64}
                aria-invalid={ownerIsInvalid}
                aria-describedby="owner-draft-help owner-draft-error"
                disabled={ownerPending}
                onChange={(event) => {
                  setOwnerDraft(event.target.value);
                  setOwnerTouched(true);
                  setMessage(null);
                }}
              />
            </label>
            <p id="owner-draft-help" className="owner-settings__help">
              {translate(locale, "settings.ownerHelp")}
            </p>
            <p id="owner-draft-error" className="owner-settings__error" role="alert">
              {ownerIsInvalid ? translate(locale, "settings.ownerInvalid") : null}
            </p>
            <button
              ref={switchOwnerButton}
              className="primary-button"
              type="button"
              disabled={!canReviewOwner}
              onClick={reviewOwnerSwitch}
            >
              {translate(locale, "settings.ownerSwitch")}
            </button>
          </section>
        ) : null}
        <section className="settings-card minecraft-component-settings">
          <h2>{translate(locale, "minecraft.components.title")}</h2>
          {componentSupported ? (
            <>
              <p>{translate(locale, "minecraft.components.verifiedInstance")}</p>
              <p>{translate(locale, "minecraft.components.scope")}</p>
              <p>{translate(locale, "minecraft.components.worldsUnchanged")}</p>
            </>
          ) : null}
          {componentLoading || componentPending ? (
            <p role="status">{translate(locale, "minecraft.components.checking")}</p>
          ) : componentStatus ? (
            <>
              <p role="status">{translate(locale, componentStatusMessageKey(componentStatus))}</p>
              {componentSupported ? (
                <>
                  <ul>
                    <li>{translate(locale, "minecraft.components.bridge")}</li>
                    <li>{translate(locale, "minecraft.components.avatar")}</li>
                  </ul>
                  <div className="inline-actions">
                    <button
                      type="button"
                      disabled={componentPending}
                      onClick={() => void mutateComponents("install", ["bridge"])}
                    >
                      {translate(locale, "minecraft.components.installBridge")}
                    </button>
                    <button
                      type="button"
                      disabled={componentPending}
                      onClick={() => void mutateComponents("install", ["bridge", "avatar"])}
                    >
                      {translate(locale, "minecraft.components.installBridgeAvatar")}
                    </button>
                    <button
                      type="button"
                      disabled={componentPending || !componentStatus.avatarInstalled}
                      onClick={() => void mutateComponents("remove", ["avatar"])}
                    >
                      {translate(locale, "minecraft.components.removeAvatar")}
                    </button>
                    <button
                      type="button"
                      disabled={componentPending || !componentStatus.bridgeInstalled}
                      onClick={() => void mutateComponents("remove", ["avatar", "bridge"])}
                    >
                      {translate(locale, "minecraft.components.removeBridge")}
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <p role="status">{translate(locale, "minecraft.components.notDetected")}</p>
          )}
          {componentFailed ? (
            <p role="alert">{translate(locale, "minecraft.components.operationFailed")}</p>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={componentPending || componentLoading}
            onClick={() => void refreshComponents()}
          >
            {translate(locale, "minecraft.components.refresh")}
          </button>
        </section>
        <section className="settings-card">
          <h2>{translate(locale, "settings.language")}</h2>
          <div className="segmented-control">
            <button
              type="button"
              aria-pressed={locale === "zh-CN"}
              onClick={() => onLocaleChange("zh-CN")}
            >
              {translate(locale, "settings.chinese")}
            </button>
            <button
              type="button"
              aria-pressed={locale === "en"}
              onClick={() => onLocaleChange("en")}
            >
              {translate(locale, "settings.english")}
            </button>
          </div>
        </section>
        <section className="settings-card settings-toggles">
          {startup ? (
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={startup.enabled}
                disabled={pending || !startup.available}
                onChange={(event) => void updateStartup(event.target.checked)}
              />
              <span>
                {translate(locale, "settings.startup")}
                {!startup.available ? (
                  <small>{translate(locale, "settings.startupUnavailable")}</small>
                ) : null}
              </span>
            </label>
          ) : (
            <p>{translate(locale, "page.loading")}</p>
          )}
          {closeDraft !== null ? (
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={closeDraft}
                disabled={pending}
                onChange={(event) => void updateCloseToTray(event.target.checked)}
              />
              <span>{translate(locale, "settings.closeToTray")}</span>
            </label>
          ) : null}
        </section>
      </div>
      {ownerReview ? (
        <div className="owner-dialog-backdrop">
          <div
            className="owner-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="owner-switch-title"
            aria-describedby="owner-switch-summary owner-switch-warning"
            onKeyDown={handleOwnerDialogKeyDown}
          >
            <h3 id="owner-switch-title">{translate(locale, "settings.ownerConfirmTitle")}</h3>
            <p id="owner-switch-summary" className="owner-dialog__summary">
              {ownerReview.oldOwner} → {ownerReview.newOwner}
            </p>
            <p id="owner-switch-warning">{translate(locale, "settings.ownerMayStopTask")}</p>
            <div className="inline-actions">
              <button
                ref={confirmOwnerButton}
                className="primary-button"
                type="button"
                disabled={ownerPending}
                onClick={() => void confirmOwnerSwitch()}
              >
                {translate(
                  locale,
                  ownerPending ? "settings.ownerPending" : "settings.ownerConfirm",
                )}
              </button>
              <button
                ref={cancelOwnerButton}
                className="secondary-button"
                type="button"
                disabled={ownerPending}
                onClick={cancelOwnerSwitch}
              >
                {translate(locale, "action.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
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

function isDocumentConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (Reflect.get(error, "code") === "DOCUMENT_CONFLICT" ||
      error.message.startsWith("DOCUMENT_CONFLICT:"))
  );
}

function parseOwnerDraft(value: string): string | null {
  try {
    return parseMinecraftJavaUsername(value);
  } catch {
    return null;
  }
}

function ownerMatchesReview(identity: OwnerIdentitySnapshot | null, review: OwnerReview): boolean {
  return (
    identity?.configured === true &&
    identity.ownerUsername === review.oldOwner &&
    identity.revision === review.expectedRevision
  );
}

function ownerAcknowledgesUpdate(
  identity: OwnerIdentitySnapshot | null,
  intent: OwnerUpdateIntent,
): identity is OwnerIdentitySnapshot & { configured: true; ownerUsername: string } {
  return (
    identity?.configured === true &&
    identity.ownerUsername === intent.review.newOwner &&
    identity.revision === intent.review.expectedRevision + 1
  );
}
