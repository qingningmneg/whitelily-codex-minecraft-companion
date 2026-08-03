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
  const actionDiagnosticError = preview
    ? actionDiagnosticRecovery(preview.actionCapability.errorCode)
    : null;

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
            <h2>{translate(locale, "diagnostics.action.title")}</h2>
            <dl>
              <dt>{translate(locale, "diagnostics.action.workspaceVersion")}</dt>
              <dd>
                {preview.actionCapability.workspaceVersion ??
                  translate(locale, "diagnostics.action.unavailable")}
              </dd>
              <dt>{translate(locale, "diagnostics.action.state")}</dt>
              <dd>
                {translate(locale, `diagnostics.action.state.${preview.actionCapability.state}`)}
              </dd>
              <dt>{translate(locale, "diagnostics.action.listening")}</dt>
              <dd>
                {translate(
                  locale,
                  preview.actionCapability.mcpListening
                    ? "diagnostics.action.yes"
                    : "diagnostics.action.no",
                )}
              </dd>
              <dt>{translate(locale, "diagnostics.action.toolCount")}</dt>
              <dd>{preview.actionCapability.discoveredToolCount}</dd>
            </dl>
            {actionDiagnosticError ? (
              <p className="page-message">
                <code>{actionDiagnosticError.code}</code>{" "}
                {translate(locale, actionDiagnosticError.messageKey)}
              </p>
            ) : null}
          </section>
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

interface ActionDiagnosticRecovery {
  readonly code: "MCP_PORT_UNAVAILABLE" | "MCP_TOOL_CATALOG_INVALID" | "MCP_READINESS_TIMEOUT";
  readonly messageKey: MessageKey;
}

function actionDiagnosticRecovery(errorCode: string | null): ActionDiagnosticRecovery | null {
  switch (errorCode) {
    case "port_conflict":
    case "server_start_failed":
      return {
        code: "MCP_PORT_UNAVAILABLE",
        messageKey: "diagnostics.action.error.MCP_PORT_UNAVAILABLE",
      };
    case "missing_tools":
    case "extra_tools":
    case "duplicate_tools":
    case "invalid_tool_name":
    case "invalid_response":
      return {
        code: "MCP_TOOL_CATALOG_INVALID",
        messageKey: "diagnostics.action.error.MCP_TOOL_CATALOG_INVALID",
      };
    case "invalid_url":
    case "invalid_timeout":
    case "connection_failed":
    case "timeout":
    case "aborted":
    case "server_closed":
    case "startup_stopped":
      return {
        code: "MCP_READINESS_TIMEOUT",
        messageKey: "diagnostics.action.error.MCP_READINESS_TIMEOUT",
      };
    default:
      return null;
  }
}
