import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface DocumentConflictNoticeProps {
  locale: Locale;
  changedFields: readonly string[];
  pending: boolean;
  onReapply(): void;
}

export function DocumentConflictNotice({
  locale,
  changedFields,
  pending,
  onReapply,
}: DocumentConflictNoticeProps) {
  return (
    <section className="conflict-notice" role="alert">
      <strong>{translate(locale, "conflict.title")}</strong>
      <p>{translate(locale, "conflict.body")}</p>
      <p>
        {translate(locale, "conflict.changedFields", {
          fields: changedFields.join(", "),
        })}
      </p>
      <button className="secondary-button" type="button" disabled={pending} onClick={onReapply}>
        {translate(locale, "conflict.reapply")}
      </button>
    </section>
  );
}
