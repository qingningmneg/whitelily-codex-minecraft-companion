import { useCallback, useEffect, useState } from "react";
import type { DocumentEnvelope } from "../../../../src/storage/documentStore.js";
import type { OwnerIdentitySnapshot } from "../../../../src/identity/ownerIdentity.js";
import type { SafetyPreset, WorldProfile } from "../../../../src/world/worldProfileSchema.js";
import { DocumentConflictNotice } from "../components/DocumentConflictNotice.js";
import { LanCandidateCard } from "../components/LanCandidateCard.js";
import type { WhiteLilyAppApi } from "../desktopApi.js";
import type { LanCandidate } from "../../src-main/discovery/lanDetector.js";
import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface WorldSafetyPageProps {
  api: Pick<
    WhiteLilyAppApi,
    | "readWorldProfile"
    | "bindConfirmedWorld"
    | "updateSafetyProfile"
    | "detectLanCandidates"
    | "confirmLanCandidate"
  >;
  locale: Locale;
  ownerIdentity: OwnerIdentitySnapshot | null;
}

type PendingWorldMutation =
  { kind: "bind"; label: string } | { kind: "preset"; safetyPreset: SafetyPreset };

export function WorldSafetyPage({ api, locale, ownerIdentity }: WorldSafetyPageProps) {
  const [envelope, setEnvelope] = useState<DocumentEnvelope<WorldProfile | null> | null>(null);
  const [preset, setPreset] = useState<SafetyPreset>("conservative");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    fields: string[];
    mutation: PendingWorldMutation;
  } | null>(null);
  const [reapplyCandidates, setReapplyCandidates] = useState<readonly LanCandidate[]>([]);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const latest = await api.readWorldProfile();
      setEnvelope(latest);
      if (latest.value) setPreset(latest.value.safetyPreset);
    } catch {
      setMessage(translate(locale, "world.error"));
    }
  }, [api, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (mutation: PendingWorldMutation): Promise<void> => {
    if (!envelope || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const latest =
        mutation.kind === "bind"
          ? await api.bindConfirmedWorld({
              expectedRevision: envelope.revision,
              label: mutation.label,
            })
          : await api.updateSafetyProfile({
              expectedRevision: envelope.revision,
              safetyPreset: mutation.safetyPreset,
            });
      setEnvelope(latest);
      if (latest.value) setPreset(latest.value.safetyPreset);
      setConflict(null);
      setReapplyCandidates([]);
    } catch (error) {
      if (isDocumentConflict(error)) {
        try {
          const latest = await api.readWorldProfile();
          setConflict({
            fields: worldChangedFields(locale, envelope.value, latest.value),
            mutation,
          });
          setEnvelope(latest);
        } catch {
          setMessage(translate(locale, "world.error"));
        }
      } else {
        setMessage(translate(locale, "world.error"));
      }
    } finally {
      setPending(false);
    }
  };

  const prepareBindReapply = async (): Promise<void> => {
    if (!conflict || conflict.mutation.kind !== "bind" || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const candidates = await api.detectLanCandidates();
      setReapplyCandidates(candidates);
      if (candidates.length === 0) setMessage(translate(locale, "world.noLanCandidates"));
    } catch {
      setMessage(translate(locale, "world.reconfirmFailed"));
    } finally {
      setPending(false);
    }
  };

  const confirmBindReapply = async (candidateId: string): Promise<void> => {
    if (!conflict || conflict.mutation.kind !== "bind" || pending) return;
    setPending(true);
    setMessage(null);
    try {
      await api.confirmLanCandidate(candidateId);
    } catch {
      setMessage(translate(locale, "world.reconfirmFailed"));
      setReapplyCandidates([]);
      setPending(false);
      return;
    }
    setPending(false);
    await mutate(conflict.mutation);
  };

  if (!envelope) {
    return (
      <main className="content-page">
        <p className="state-panel">{message ?? translate(locale, "page.loading")}</p>
      </main>
    );
  }

  return (
    <main className="content-page">
      <header className="page-header">
        <p className="page-eyebrow">{translate(locale, "world.eyebrow")}</p>
        <h1>{translate(locale, "world.title")}</h1>
        <p>{translate(locale, "world.subtitle")}</p>
      </header>
      {conflict ? (
        <DocumentConflictNotice
          locale={locale}
          changedFields={conflict.fields}
          pending={pending}
          onReapply={() =>
            void (conflict.mutation.kind === "bind"
              ? prepareBindReapply()
              : mutate(conflict.mutation))
          }
        />
      ) : null}
      {reapplyCandidates.length > 0 ? (
        <section className="settings-card">
          <p>{translate(locale, "world.reconfirmInstruction")}</p>
          <div className="candidate-list">
            {reapplyCandidates.map((candidate) => (
              <LanCandidateCard
                key={candidate.id}
                candidate={candidate}
                locale={locale}
                pending={pending}
                disabled={pending}
                onConfirm={(candidateId) => void confirmBindReapply(candidateId)}
              />
            ))}
          </div>
        </section>
      ) : null}
      {message ? (
        <p className="page-message" role="status">
          {message}
        </p>
      ) : null}

      <section className="settings-card">
        {envelope.value ? (
          <div className="world-identity">
            <div>
              <h2>{envelope.value.label}</h2>
              {ownerIdentity?.configured && ownerIdentity.ownerUsername ? (
                <p>{translate(locale, "world.owner", { owner: ownerIdentity.ownerUsername })}</p>
              ) : null}
            </div>
            <span className="verified-chip">✓</span>
          </div>
        ) : (
          <div className="world-bind">
            <p>{translate(locale, "world.none")}</p>
            <label>
              <span>{translate(locale, "world.label")}</span>
              <input
                value={label}
                maxLength={160}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={pending || label.trim().length === 0}
              onClick={() => void mutate({ kind: "bind", label: label.trim() })}
            >
              {translate(locale, "world.bind")}
            </button>
          </div>
        )}
      </section>

      {envelope.value ? (
        <section className="settings-card">
          <fieldset className="preset-options">
            <legend>{translate(locale, "world.preset")}</legend>
            <label>
              <input
                type="radio"
                name="safety-preset"
                checked={preset === "conservative"}
                onChange={() => setPreset("conservative")}
              />
              <span>{translate(locale, "world.conservative")}</span>
            </label>
            <label>
              <input
                type="radio"
                name="safety-preset"
                checked={preset === "standard"}
                onChange={() => setPreset("standard")}
              />
              <span>{translate(locale, "world.standard")}</span>
            </label>
          </fieldset>
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => void mutate({ kind: "preset", safetyPreset: preset })}
          >
            {translate(locale, "world.save")}
          </button>
        </section>
      ) : null}

      <section className="settings-card hard-caps">
        <h2>{translate(locale, "world.hardCaps")}</h2>
        <ul>
          <li>{translate(locale, "world.toolCallsCap")}</li>
          <li>{translate(locale, "world.blockChangesCap")}</li>
          <li>{translate(locale, "world.travelCap")}</li>
          <li>{translate(locale, "world.durationCap")}</li>
        </ul>
        <p className="permanent-deny">{translate(locale, "world.permanentDeny")}</p>
      </section>
    </main>
  );
}

function isDocumentConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("DOCUMENT_CONFLICT:");
}

function worldChangedFields(
  locale: Locale,
  previous: WorldProfile | null,
  latest: WorldProfile | null,
): string[] {
  if (!previous || !latest) return [translate(locale, "world.title")];
  const fields: string[] = [];
  if (previous.label !== latest.label) fields.push(translate(locale, "world.label"));
  if (previous.safetyPreset !== latest.safetyPreset) {
    fields.push(translate(locale, "world.preset"));
  }
  if (previous.id !== latest.id) fields.push(translate(locale, "world.title"));
  return fields.length > 0 ? fields : [translate(locale, "world.title")];
}
