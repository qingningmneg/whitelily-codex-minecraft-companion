import type { Locale, MessageKey } from "../i18n/messageKeys";
import { translate } from "../i18n/translator";

interface SidebarProps {
  locale: Locale;
  activeItem: MessageKey;
  blocked: boolean;
  onNavigate(route: AppRoute, item: MessageKey): void;
  onLocaleChange(locale: Locale): void;
}

export type AppRoute =
  | "home"
  | "persona"
  | "memory"
  | "worldSafety"
  | "model"
  | "avatarModels"
  | "diagnostics"
  | "settings";

const navigationItems: readonly {
  key: MessageKey;
  route?: AppRoute;
}[] = [
  { key: "nav.home", route: "home" },
  { key: "nav.companion", route: "persona" },
  { key: "nav.behavior", route: "persona" },
  { key: "nav.memories", route: "memory" },
  { key: "nav.worldSafety", route: "worldSafety" },
  { key: "nav.models", route: "model" },
  { key: "nav.avatarModels", route: "avatarModels" },
  { key: "nav.diagnostics", route: "diagnostics" },
  { key: "nav.settings", route: "settings" },
];

export function Sidebar({ locale, activeItem, blocked, onNavigate, onLocaleChange }: SidebarProps) {
  const nextLocale: Locale = locale === "zh-CN" ? "en" : "zh-CN";

  return (
    <aside
      className="sidebar"
      inert={blocked ? true : undefined}
      aria-hidden={blocked ? true : undefined}
    >
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">
          WL
        </span>
        <div>
          <p className="brand-name">WhiteLily</p>
          <p className="brand-edition">Public Beta</p>
        </div>
      </div>

      <nav aria-label={translate(locale, "nav.label")}>
        <ul className="nav-list">
          {navigationItems.map(({ key, route }) => (
            <li key={key}>
              {route ? (
                <a
                  className={`nav-item${activeItem === key ? " nav-item--active" : ""}`}
                  href={`#${route}`}
                  aria-current={activeItem === key ? "page" : undefined}
                  aria-disabled={blocked ? true : undefined}
                  tabIndex={blocked ? -1 : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!blocked) onNavigate(route, key);
                  }}
                >
                  <span className="nav-dot" aria-hidden="true" />
                  {translate(locale, key)}
                </a>
              ) : (
                <span className="nav-item nav-item--pending" aria-disabled="true">
                  <span className="nav-dot" aria-hidden="true" />
                  <span>{translate(locale, key)}</span>
                  <span className="nav-soon">{translate(locale, "nav.soon")}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <button
        className="locale-button"
        type="button"
        disabled={blocked}
        onClick={() => {
          if (!blocked) onLocaleChange(nextLocale);
        }}
      >
        <span aria-hidden="true">↔</span>
        {translate(locale, "locale.switch")}
      </button>
    </aside>
  );
}
