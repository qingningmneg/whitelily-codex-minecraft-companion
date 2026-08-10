import { useId } from "react";
import type { LanCandidate } from "../../src-main/discovery/lanDetector";
import type { Locale } from "../i18n/messageKeys";
import { translate } from "../i18n/translator";

interface LanCandidateCardProps {
  candidate: LanCandidate;
  locale: Locale;
  pending: boolean;
  disabled: boolean;
  onConfirm(candidateId: string): void;
}

export function LanCandidateCard({
  candidate,
  locale,
  pending,
  disabled,
  onConfirm,
}: LanCandidateCardProps) {
  const id = useId();
  const observedDate = new Date(candidate.observedAt);
  const observedDateTime = Number.isNaN(observedDate.valueOf())
    ? undefined
    : observedDate.toISOString();
  const headingId = `${id}-candidate`;
  const descriptionId = `${id}-version`;
  const publicVersion =
    candidate.version === "unknown"
      ? translate(locale, "onboarding.lan.versionUnknown")
      : translate(locale, "onboarding.lan.version", { version: candidate.version });

  return (
    <article className="lan-candidate" aria-labelledby={headingId} aria-describedby={descriptionId}>
      <div className="lan-candidate__body">
        <div>
          <h2 id={headingId} className="lan-candidate__port">
            {translate(locale, "onboarding.lan.candidate")}
          </h2>
          <p id={descriptionId} className="lan-candidate__version">
            {publicVersion}
          </p>
        </div>
        <time dateTime={observedDateTime}>{translate(locale, "onboarding.lan.observed")}</time>
      </div>
      {candidate.version === "unknown" ? (
        <p className="candidate-warning">
          {translate(locale, "onboarding.error.MINECRAFT_VERSION_UNVERIFIED")}
        </p>
      ) : null}
      <button
        className="primary-button"
        type="button"
        disabled={disabled}
        aria-label={translate(
          locale,
          pending ? "onboarding.lan.connectingCandidate" : "onboarding.lan.confirmCandidate",
        )}
        aria-describedby={descriptionId}
        onClick={() => onConfirm(candidate.id)}
      >
        {translate(locale, pending ? "onboarding.lan.connecting" : "onboarding.lan.confirm")}
      </button>
    </article>
  );
}
