import { useCallback, useEffect, useState } from "react";
import type { DiagnosticPreview } from "../../../../src/desktop/desktopProtocol.js";
import type { WhiteLilyTask5Api } from "../desktopApi.js";
import type { Locale, MessageKey } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface DiagnosticsPageProps {
  api: Pick<WhiteLilyTask5Api, "previewDiagnostics" | "exportDiagnostics">;
  locale: Locale;
}

export function DiagnosticsPage({ api, locale }: DiagnosticsPageProps) {
  const [preview, setPreview] = useState<DiagnosticPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMessage(null);
    setPreview(null);
    try {
      setPreview(await api.previewDiagnostics());
    } catch {
      setMessage(translate(locale, "diagnostics.error"));
    }
  }, [api, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportArchive = async (): Promise<void> => {
    if (!preview || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await api.exportDiagnostics(preview.exportId);
      setMessage(
        translate(
          locale,
          result.status === "saved" ? "diagnostics.saved" : "diagnostics.cancelled",
        ),
      );
      if (result.status === "saved") setPreview(null);
    } catch {
      setPreview(null);
      setMessage(translate(locale, "diagnostics.error"));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="content-page">
      <header className="page-header">
        <p className="page-eyebrow">{translate(locale, "diagnostics.eyebrow")}</p>
        <h1>{translate(locale, "diagnostics.title")}</h1>
        <p>{translate(locale, "diagnostics.subtitle")}</p>
      </header>
      <p className="page-message">{translate(locale, "diagnostics.localOnly")}</p>
      {message ? (
        <p className="page-message" role="status">
          {message}
        </p>
      ) : null}
      {preview ? (
        <>
          <section className="settings-card">
            <h2>{translate(locale, "diagnostics.files")}</h2>
            <ul className="memory-list">
              {preview.files.map((file) => (
                <li key={file.logicalName}>
                  <strong>{file.logicalName}</strong>
                  <span>{translate(locale, "diagnostics.bytes", { count: file.size })}</span>
                  <span>
                    {translate(locale, "diagnostics.redactions", { count: file.redactions })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="settings-card">
            <h2>{translate(locale, "diagnostics.omitted")}</h2>
            <ul>
              {preview.omitted.map((item) => (
                <li key={item}>{omissionLabel(locale, item)}</li>
              ))}
            </ul>
          </section>
          <button
            className="primary-action"
            type="button"
            disabled={pending}
            onClick={() => void exportArchive()}
          >
            {translate(locale, pending ? "diagnostics.exporting" : "diagnostics.export")}
          </button>
        </>
      ) : message ? (
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {translate(locale, "page.retry")}
        </button>
      ) : (
        <p>{translate(locale, "page.loading")}</p>
      )}
    </main>
  );
}

function omissionLabel(locale: Locale, value: string): string {
  const key = `diagnostics.omission.${value}` as MessageKey;
  return translate(locale, key);
}
