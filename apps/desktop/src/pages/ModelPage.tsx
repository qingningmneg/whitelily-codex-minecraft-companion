import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ModelCatalogSnapshot,
  ModelSelection,
  ModelSelectionInput,
} from "../../../../src/codex/modelCatalog.js";
import type { WhiteLilyDesktopApi } from "../desktopApi.js";
import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface ModelPageProps {
  api: WhiteLilyDesktopApi;
  locale: Locale;
}

export function ModelPage({ api, locale }: ModelPageProps) {
  const [catalog, setCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [modelId, setModelId] = useState("automatic");
  const [effort, setEffort] = useState("");
  const [pending, setPending] = useState(false);
  const [retrySelection, setRetrySelection] = useState<ModelSelectionInput | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const live = await api.listModels();
      setCatalog(live);
      setRetrySelection(null);
      if (live.selection.mode === "automatic") {
        setModelId("automatic");
        setEffort("");
      } else {
        setModelId(live.selection.modelId);
        setEffort(live.selection.reasoningEffort);
      }
    } catch {
      setMessage({ kind: "error", text: translate(locale, "model.error") });
    }
  }, [api, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => catalog?.models.find((model) => model.id === modelId),
    [catalog, modelId],
  );

  const changeModel = (nextId: string): void => {
    setMessage(null);
    setRetrySelection(null);
    setModelId(nextId);
    const next = catalog?.models.find((model) => model.id === nextId);
    setEffort(next?.supportedReasoningEfforts[0] ?? "");
  };

  const apply = async (): Promise<void> => {
    if (pending || !catalog) return;
    const previous = catalog.selection;
    const requested =
      retrySelection ??
      (modelId === "automatic"
        ? ({ mode: "automatic" } as const)
        : ({ mode: "explicit", modelId, reasoningEffort: effort } as const));
    setPending(true);
    setMessage(null);
    try {
      const confirmed = await api.selectModel(requested);
      setCatalog((current) => (current ? { ...current, selection: confirmed } : current));
      setDraftFromSelection(confirmed);
      setRetrySelection(null);
      setMessage({ kind: "success", text: successMessage(locale, catalog, confirmed) });
    } catch {
      setDraftFromSelection(previous);
      setRetrySelection(requested);
      setMessage({ kind: "error", text: translate(locale, "model.error") });
    } finally {
      setPending(false);
    }
  };

  const setDraftFromSelection = (selection: ModelSelection): void => {
    if (selection.mode === "automatic") {
      setModelId("automatic");
      setEffort("");
      return;
    }
    setModelId(selection.modelId);
    setEffort(selection.reasoningEffort);
  };

  return (
    <main className="content-page">
      <header className="page-header">
        <p className="page-eyebrow">{translate(locale, "model.eyebrow")}</p>
        <h1>{translate(locale, "model.title")}</h1>
        <p>{translate(locale, "model.subtitle")}</p>
      </header>
      {message ? (
        <p className="page-message" role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      {!catalog ? (
        <p className="state-panel">{translate(locale, "page.loading")}</p>
      ) : (
        <section className="settings-card model-settings">
          {catalog.models.length === 0 ? <p>{translate(locale, "model.empty")}</p> : null}
          <label>
            <span>{translate(locale, "model.label")}</span>
            <select
              value={modelId}
              disabled={pending}
              onChange={(event) => changeModel(event.target.value)}
            >
              <option value="automatic">{translate(locale, "model.automatic")}</option>
              {catalog.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{translate(locale, "model.effort")}</span>
            <select
              value={effort}
              disabled={pending || modelId === "automatic"}
              onChange={(event) => {
                setMessage(null);
                setRetrySelection(null);
                setEffort(event.target.value);
              }}
            >
              {(selected?.supportedReasoningEfforts ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => void apply()}
          >
            {translate(
              locale,
              pending
                ? "model.switching"
                : message?.kind === "error"
                  ? "model.retry"
                  : "model.apply",
            )}
          </button>
        </section>
      )}
    </main>
  );
}

function successMessage(
  locale: Locale,
  catalog: ModelCatalogSnapshot,
  selection: ModelSelection,
): string {
  if (selection.mode === "automatic") return translate(locale, "model.successAutomatic");
  const model = catalog.models.find((candidate) => candidate.id === selection.modelId);
  return translate(locale, "model.success", {
    model: model?.displayName ?? selection.modelId,
    effort: selection.reasoningEffort,
  });
}
