import { useState } from "react";
import type { AvatarAppearanceListItem } from "../../../../src/avatar/avatarModelSchemas.js";
import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface AvatarModelCardProps {
  locale: Locale;
  model: AvatarAppearanceListItem;
  active: boolean;
  pending: boolean;
  onSelect(modelId: string): void;
  onKeyDown?(event: React.KeyboardEvent<HTMLButtonElement>): void;
}

export function AvatarModelCard({
  locale,
  model,
  active,
  pending,
  onSelect,
  onKeyDown,
}: AvatarModelCardProps) {
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const preview = model.portraitDataUrl ?? model.previewDataUrl;

  return (
    <button
      className="avatar-model-card"
      type="button"
      data-avatar-model-id={model.id}
      aria-label={model.displayName}
      aria-pressed={active}
      disabled={pending}
      onClick={() => onSelect(model.id)}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (typeof event.currentTarget.scrollIntoView === "function") {
          event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }}
    >
      <span className="avatar-model-card__preview-frame">
        {previewUnavailable ? (
          <span
            className="avatar-preview-fallback"
            data-testid="avatar-preview-fallback"
            aria-hidden="true"
          />
        ) : (
          <img
            className="avatar-model-card__preview"
            src={preview}
            alt={model.displayName}
            onError={() => setPreviewUnavailable(true)}
          />
        )}
      </span>
      <span className="avatar-model-card__details">
        <strong>{model.displayName}</strong>
        <span>{translate(locale, `avatarModels.armModel.${model.armModel}`)}</span>
        {active ? (
          <span className="avatar-model-card__active">
            {translate(locale, "avatarModels.active")}
          </span>
        ) : null}
        {pending ? (
          <span className="avatar-model-card__pending" role="status">
            {translate(locale, "avatarModels.pending")}
          </span>
        ) : null}
      </span>
    </button>
  );
}
