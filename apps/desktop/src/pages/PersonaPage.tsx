import { useCallback, useEffect, useState } from "react";
import type { CompanionMode } from "../../../../src/domain/types.js";
import type {
  BehaviorModeSettings,
  CompanionProfile,
} from "../../../../src/profile/profileSchema.js";
import type { DocumentEnvelope } from "../../../../src/storage/documentStore.js";
import { DocumentConflictNotice } from "../components/DocumentConflictNotice.js";
import type { WhiteLilyTask5Api } from "../desktopApi.js";
import type { Locale, MessageKey } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface PersonaPageProps {
  api: Pick<WhiteLilyTask5Api, "readProfile" | "updateProfile">;
  locale: Locale;
}

const modes: readonly CompanionMode[] = ["friend", "balanced", "autonomous"];
const modeKeys: Readonly<Record<CompanionMode, MessageKey>> = {
  friend: "persona.mode.friend",
  balanced: "persona.mode.balanced",
  autonomous: "persona.mode.autonomous",
};

export function PersonaPage({ api, locale }: PersonaPageProps) {
  const [base, setBase] = useState<DocumentEnvelope<CompanionProfile> | null>(null);
  const [draft, setDraft] = useState<CompanionProfile | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictFields, setConflictFields] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const envelope = await api.readProfile();
      setBase(envelope);
      setDraft((current) => current ?? structuredClone(envelope.value));
    } catch {
      setMessage(translate(locale, "persona.error"));
    }
  }, [api, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (): Promise<void> => {
    if (!base || !draft || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await api.updateProfile({
        expectedRevision: base.revision,
        profile: draft,
      });
      setBase(result.envelope);
      setDraft(structuredClone(result.envelope.value));
      setConflictFields(null);
      setMessage(translate(locale, "persona.saved"));
    } catch (error) {
      if (isDocumentConflict(error)) {
        try {
          const latest = await api.readProfile();
          setConflictFields(profileChangedFields(locale, base.value, latest.value));
          setBase(latest);
        } catch {
          setMessage(translate(locale, "persona.error"));
        }
      } else {
        setMessage(translate(locale, "persona.error"));
      }
    } finally {
      setPending(false);
    }
  };

  if (!base || !draft) {
    return (
      <main className="content-page">
        <p className="state-panel">{message ?? translate(locale, "page.loading")}</p>
      </main>
    );
  }

  const modeSettings = draft.modeSettings[draft.mode];
  const updateSettings = (patch: Partial<BehaviorModeSettings>): void => {
    setDraft({
      ...draft,
      modeSettings: {
        ...draft.modeSettings,
        [draft.mode]: { ...modeSettings, ...patch },
      },
    });
  };

  return (
    <main className="content-page">
      <PageHeader
        eyebrow={translate(locale, "persona.eyebrow")}
        title={translate(locale, "persona.title")}
        subtitle={translate(locale, "persona.subtitle")}
      />
      {conflictFields ? (
        <DocumentConflictNotice
          locale={locale}
          changedFields={conflictFields}
          pending={pending}
          onReapply={() => void persist()}
        />
      ) : null}
      {message ? (
        <p className="page-message" role="status">
          {message}
        </p>
      ) : null}

      <section className="settings-card form-grid">
        <label>
          <span>{translate(locale, "persona.name")}</span>
          <input
            value={draft.displayName}
            maxLength={16}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          />
        </label>
        <label>
          <span>{translate(locale, "persona.language")}</span>
          <select
            value={draft.language}
            onChange={(event) =>
              setDraft({ ...draft, language: event.target.value as CompanionProfile["language"] })
            }
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="form-grid__wide">
          <span>{translate(locale, "persona.tone")}</span>
          <input
            value={draft.tone}
            maxLength={160}
            onChange={(event) => setDraft({ ...draft, tone: event.target.value })}
          />
        </label>
        <label>
          <span>{translate(locale, "persona.preferredTopics")}</span>
          <input
            value={draft.preferredTopics.join(", ")}
            onChange={(event) =>
              setDraft({ ...draft, preferredTopics: splitTopics(event.target.value) })
            }
          />
        </label>
        <label>
          <span>{translate(locale, "persona.avoidedTopics")}</span>
          <input
            value={draft.avoidedTopics.join(", ")}
            onChange={(event) =>
              setDraft({ ...draft, avoidedTopics: splitTopics(event.target.value) })
            }
          />
        </label>
        <div className="form-grid__wide">
          <button
            className="disclosure-button"
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            {translate(locale, "persona.advanced")}
          </button>
          {advanced ? (
            <label className="advanced-field">
              <span>{translate(locale, "persona.advanced")}</span>
              <textarea
                value={draft.persona}
                maxLength={4_000}
                rows={6}
                onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
              />
            </label>
          ) : null}
        </div>
      </section>

      <section className="settings-card">
        <div
          className="segmented-control"
          role="group"
          aria-label={translate(locale, "nav.behavior")}
        >
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={draft.mode === mode}
              onClick={() => setDraft({ ...draft, mode })}
            >
              {translate(locale, modeKeys[mode])}
            </button>
          ))}
        </div>
        <div className="mode-settings">
          <label>
            <span>{translate(locale, "persona.idleMinutes")}</span>
            <input
              type="number"
              min={1}
              max={120}
              value={modeSettings.idleMinutes}
              onChange={(event) => updateSettings({ idleMinutes: Number(event.target.value) })}
            />
          </label>
          <Toggle
            label={translate(locale, "persona.proactiveChat")}
            checked={modeSettings.allowProactiveChat}
            onChange={(checked) => updateSettings({ allowProactiveChat: checked })}
          />
          <Toggle
            label={translate(locale, "persona.suggestions")}
            checked={modeSettings.allowSuggestions}
            onChange={(checked) => updateSettings({ allowSuggestions: checked })}
          />
          <Toggle
            label={translate(locale, "persona.microActions")}
            checked={modeSettings.allowLowRiskMicroActions}
            onChange={(checked) => updateSettings({ allowLowRiskMicroActions: checked })}
          />
        </div>
      </section>
      <div className="page-actions">
        <button
          className="primary-button"
          type="button"
          disabled={pending}
          onClick={() => void persist()}
        >
          {translate(locale, "persona.save")}
        </button>
      </div>
    </main>
  );
}

function PageHeader(props: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <header className="page-header">
      <p className="page-eyebrow">{props.eyebrow}</p>
      <h1>{props.title}</h1>
      <p>{props.subtitle}</p>
    </header>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

function splitTopics(value: string): string[] {
  return value
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function isDocumentConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("DOCUMENT_CONFLICT:");
}

function profileChangedFields(
  locale: Locale,
  previous: CompanionProfile,
  latest: CompanionProfile,
): string[] {
  const fields: Array<[keyof CompanionProfile, MessageKey]> = [
    ["displayName", "persona.name"],
    ["language", "persona.language"],
    ["tone", "persona.tone"],
    ["preferredTopics", "persona.preferredTopics"],
    ["avoidedTopics", "persona.avoidedTopics"],
    ["persona", "persona.advanced"],
    ["mode", "nav.behavior"],
    ["modeSettings", "nav.behavior"],
  ];
  const changed = fields
    .filter(([field]) => JSON.stringify(previous[field]) !== JSON.stringify(latest[field]))
    .map(([, key]) => translate(locale, key));
  return changed.length > 0 ? [...new Set(changed)] : [translate(locale, "persona.title")];
}
