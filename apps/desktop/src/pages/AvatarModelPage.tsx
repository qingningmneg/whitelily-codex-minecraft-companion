import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarModelCatalogSnapshot } from "../../../../src/avatar/avatarModelSchemas.js";
import { AvatarModelCard } from "../components/AvatarModelCard.js";
import type { WhiteLilyAvatarApi } from "../desktopApi.js";
import type { Locale, MessageKey } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface AvatarModelPageProps {
  api: WhiteLilyAvatarApi;
  locale: Locale;
}

export function AvatarModelPage({ api, locale }: AvatarModelPageProps) {
  const [catalog, setCatalog] = useState<AvatarModelCatalogSnapshot | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    const applyCatalog = (next: AvatarModelCatalogSnapshot): void => {
      if (!mounted) return;
      setCatalog(next);
      if (next.pendingModelId === undefined) setSwitchingId(null);
    };
    const unsubscribe = api.subscribeAvatarModels(applyCatalog);
    void api.listAvatarModels().then(applyCatalog, () => {
      if (mounted) setErrorKey("avatarModels.error.load");
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);

  const importModel = async (): Promise<void> => {
    if (importing) return;
    setImporting(true);
    setErrorKey(null);
    try {
      const result = await api.importAvatarModel();
      if (result.status === "imported") {
        setCatalog((current) =>
          current && !current.models.some((model) => model.id === result.model.id)
            ? { ...current, models: [...current.models, result.model] }
            : current,
        );
      }
    } catch (error) {
      setErrorKey(errorMessageKey(error, "import"));
    } finally {
      setImporting(false);
    }
  };

  const selectModel = async (modelId: string): Promise<void> => {
    if (!catalog || switchingId !== null || modelId === catalog.activeModelId) return;
    setErrorKey(null);
    setSwitchingId(modelId);
    try {
      const confirmed = await api.switchAvatarModel(modelId);
      setCatalog(confirmed);
    } catch (error) {
      setErrorKey(errorMessageKey(error, "switch"));
    } finally {
      setSwitchingId(null);
    }
  };

  const moveFocus = useCallback((event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "Home" && event.key !== "End") return;
    const cards = track.current?.querySelectorAll<HTMLButtonElement>("[data-avatar-model-id]");
    if (!cards?.length) return;
    event.preventDefault();
    (event.key === "Home" ? cards[0] : cards[cards.length - 1])?.focus();
  }, []);

  const pendingModelId = catalog?.pendingModelId ?? switchingId;

  return (
    <main className="content-page avatar-model-page">
      <header className="page-header avatar-model-page__header">
        <div>
          <p className="page-eyebrow">{translate(locale, "avatarModels.eyebrow")}</p>
          <h1>{translate(locale, "avatarModels.title")}</h1>
          <p>{translate(locale, "avatarModels.subtitle")}</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={importing}
          onClick={() => void importModel()}
        >
          {translate(locale, importing ? "avatarModels.importing" : "avatarModels.import")}
        </button>
      </header>
      {errorKey ? <p className="page-message" role="alert">{translate(locale, errorKey)}</p> : null}
      {!catalog ? (
        <p className="state-panel">{translate(locale, "page.loading")}</p>
      ) : (
        <div className="avatar-model-track-viewport" data-testid="avatar-model-track-viewport">
          <div className="avatar-model-track" data-testid="avatar-model-track" ref={track}>
            {catalog.models.map((model) => (
              <AvatarModelCard
                key={model.id}
                locale={locale}
                model={model}
                active={model.id === catalog.activeModelId}
                pending={model.id === pendingModelId}
                onSelect={(modelId) => void selectModel(modelId)}
                onKeyDown={moveFocus}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

function errorMessageKey(error: unknown, operation: "import" | "switch"): MessageKey {
  const code =
    error && typeof error === "object" && typeof Reflect.get(error, "code") === "string"
      ? Reflect.get(error, "code")
      : "";
  if (operation === "switch" && code === "AVATAR_BRIDGE_DISCONNECTED") {
    return "avatarModels.error.bridgeDisconnected";
  }
  if (operation === "switch" && code === "AVATAR_WORLD_CHANGED") {
    return "avatarModels.error.worldChanged";
  }
  if (operation === "import" && code === "AVATAR_FORMAT_UNSUPPORTED") {
    return "avatarModels.error.formatUnsupported";
  }
  return operation === "import" ? "avatarModels.error.import" : "avatarModels.error.switch";
}
