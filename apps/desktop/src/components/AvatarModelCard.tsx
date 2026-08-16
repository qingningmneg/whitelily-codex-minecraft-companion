import type { AvatarModelListItem } from "../../../../src/avatar/avatarModelSchemas.js";
import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface AvatarModelCardProps {
  locale: Locale;
  model: AvatarModelListItem;
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
  const builtinHd = model.format === "builtin-hd";

  return (
    <button
      className={`avatar-model-card${builtinHd ? " avatar-model-card--builtin-hd" : ""}`}
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
        <img
          className="avatar-model-card__preview"
          src={model.previewDataUrl}
          alt={model.displayName}
        />
      </span>
      <span className="avatar-model-card__details">
        <strong>{model.displayName}</strong>
        <span>{model.format.toUpperCase()}</span>
        {active ? <span className="avatar-model-card__active">{translate(locale, "avatarModels.active")}</span> : null}
        {pending ? (
          <span className="avatar-model-card__pending" role="status">
            {translate(locale, "avatarModels.pending")}
          </span>
        ) : null}
      </span>
    </button>
  );
}
