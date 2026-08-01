import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelCatalogSnapshot } from "../../../../src/codex/modelCatalog.js";
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
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const live = await api.listModels();
      setCatalog(live);
      if (live.selection.mode === "automatic") {
        setModelId("automatic");
        setEffort("");
      } else {
        setModelId(live.selection.modelId);
        setEffort(live.selection.reasoningEffort);
      }
    } catch {
      setMessage(translate(locale, "model.error"));
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
    setModelId(nextId);
    const next = catalog?.models.find((model) => model.id === nextId);
    setEffort(next?.supportedReasoningEfforts[0] ?? "");
  };

  const apply = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await api.selectModel(
        modelId === "automatic"
          ? { mode: "automatic" }
          : { mode: "explicit", modelId, reasoningEffort: effort },
      );
      await load();
    } catch {
      setMessage(translate(locale, "model.error"));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="content-page">
      <header className="page-header">
        <p className="page-eyebrow">{translate(locale, "model.eyebrow")}</p>
        <h1>{translate(locale, "model.title")}</h1>
        <p>{translate(locale, "model.subtitle")}</p>
      </header>
      {message ? (
        <p className="page-message" role="alert">
          {message}
        </p>
      ) : null}
      {!catalog ? (
        <p className="state-panel">{translate(locale, "page.loading")}</p>
      ) : (
        <section className="settings-card model-settings">
          {catalog.models.length === 0 ? <p>{translate(locale, "model.empty")}</p> : null}
          <label>
            <span>{translate(locale, "model.label")}</span>
            <select value={modelId} onChange={(event) => changeModel(event.target.value)}>
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
              disabled={modelId === "automatic"}
              onChange={(event) => setEffort(event.target.value)}
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
            {translate(locale, "model.apply")}
          </button>
        </section>
      )}
    </main>
  );
}
