import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";
import type { MemoryMigrationPreviewResult } from "../desktopApi.js";

interface MemoryMigrationPreviewProps {
  locale: Locale;
  preview: MemoryMigrationPreviewResult;
  pending: boolean;
  committed: boolean;
  onCommit(): void;
  onRollback(): void;
}

export function MemoryMigrationPreview({
  locale,
  preview,
  pending,
  committed,
  onCommit,
  onRollback,
}: MemoryMigrationPreviewProps) {
  return (
    <div className="migration-preview" aria-live="polite">
      <p>
        {translate(locale, "memory.migrationPreviewCount", {
          moved: preview.movedCount,
          deduplicated: preview.deduplicatedCount,
        })}
      </p>
      <div className="inline-actions">
        <button className="primary-button" type="button" disabled={pending} onClick={onCommit}>
          {translate(locale, "memory.commitMigration")}
        </button>
        {committed ? (
          <button
            className="secondary-button"
            type="button"
            disabled={pending}
            onClick={onRollback}
          >
            {translate(locale, "memory.rollbackMigration")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
