import { useEffect, useRef, useState } from "react";
import type {
  ModelCatalogSnapshot,
  ModelSelection,
  ModelSelectionInput,
} from "../../../../src/codex/modelCatalog";
import type { Locale } from "../i18n/messageKeys";
import { translate } from "../i18n/translator";

interface ModelPickerProps {
  locale: Locale;
  catalog: ModelCatalogSnapshot;
  onSelect(selection: ModelSelectionInput): Promise<ModelSelection>;
  onApplied(selection: ModelSelection): void;
  onContinue(): void;
}

interface DraftSelection {
  modelId: "automatic" | string;
  reasoningEffort: string;
}

export function ModelPicker({
  locale,
  catalog,
  onSelect,
  onApplied,
  onContinue,
}: ModelPickerProps) {
  const [draft, setDraft] = useState<DraftSelection>(() => draftFromSelection(catalog));
  const [confirmed, setConfirmed] = useState<ModelSelection>(catalog.selection);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const intent = useRef(0);
  const operationTail = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      intent.current += 1;
    };
  }, []);

  const applyIntent = (input: ModelSelectionInput, nextDraft: DraftSelection): void => {
    const request = ++intent.current;
    setDraft(nextDraft);
    setPending(true);
    setFailed(false);
    operationTail.current = operationTail.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const selected = await onSelect(input);
          if (!mounted.current || request !== intent.current) return;
          setConfirmed(selected);
          setFailed(false);
          onApplied(selected);
        } catch {
          if (!mounted.current || request !== intent.current) return;
          setFailed(true);
        } finally {
          if (mounted.current && request === intent.current) setPending(false);
        }
      });
  };

  const selectedModel =
    draft.modelId === "automatic"
      ? undefined
      : catalog.models.find((model) => model.id === draft.modelId);

  return (
    <div className="model-picker">
      <label>
        <span>{translate(locale, "onboarding.model.label")}</span>
        <select
          aria-label={translate(locale, "onboarding.model.label")}
          value={draft.modelId}
          onChange={(event) => {
            const modelId = event.currentTarget.value;
            if (modelId === "automatic") {
              applyIntent({ mode: "automatic" }, { modelId: "automatic", reasoningEffort: "" });
              return;
            }
            const model = catalog.models.find((candidate) => candidate.id === modelId);
            const reasoningEffort = model?.supportedReasoningEfforts[0];
            if (!model || !reasoningEffort) return;
            applyIntent(
              { mode: "explicit", modelId, reasoningEffort },
              { modelId, reasoningEffort },
            );
          }}
        >
          <option value="automatic">{translate(locale, "onboarding.model.automatic")}</option>
          {catalog.models.map((model) => (
            <option value={model.id} key={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>

      {selectedModel ? (
        <label>
          <span>{translate(locale, "onboarding.model.effort")}</span>
          <select
            aria-label={translate(locale, "onboarding.model.effort")}
            value={draft.reasoningEffort}
            onChange={(event) => {
              const reasoningEffort = event.currentTarget.value;
              applyIntent(
                {
                  mode: "explicit",
                  modelId: selectedModel.id,
                  reasoningEffort,
                },
                { modelId: selectedModel.id, reasoningEffort },
              );
            }}
          >
            {selectedModel.supportedReasoningEfforts.map((effort) => (
              <option value={effort} key={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <p
        className={
          failed ? "model-picker__status model-picker__status--error" : "model-picker__status"
        }
        role="status"
        aria-live="polite"
      >
        {failed
          ? translate(locale, "onboarding.error.MODEL_UNAVAILABLE")
          : pending
            ? translate(locale, "onboarding.model.applying")
            : selectionLabel(locale, catalog, confirmed)}
      </p>

      <button
        className="primary-button"
        type="button"
        disabled={pending || failed}
        onClick={onContinue}
      >
        {translate(locale, "onboarding.model.continue")}
      </button>
    </div>
  );
}

function draftFromSelection(catalog: ModelCatalogSnapshot): DraftSelection {
  const selection = catalog.selection;
  return selection.mode === "automatic"
    ? { modelId: "automatic", reasoningEffort: "" }
    : { modelId: selection.modelId, reasoningEffort: selection.reasoningEffort };
}

function selectionLabel(
  locale: Locale,
  catalog: ModelCatalogSnapshot,
  selection: ModelSelection,
): string {
  if (selection.mode === "automatic") {
    return translate(locale, "onboarding.model.selectedAutomatic");
  }
  const displayName =
    catalog.models.find((candidate) => candidate.id === selection.modelId)?.displayName ??
    translate(locale, "onboarding.model.unavailable");
  return translate(locale, "onboarding.model.selectedExplicit", {
    model: displayName,
    effort: selection.reasoningEffort,
  });
}
