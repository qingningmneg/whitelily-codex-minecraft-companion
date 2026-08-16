import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnerIdentitySnapshot } from "../../../src/identity/ownerIdentity";
import { Sidebar, type AppRoute } from "./components/Sidebar";
import { ApplicationExitButton } from "./components/ApplicationExitButton";
import type {
  OwnerIdentityAuthoritySnapshot,
  WhiteLilyAppApi,
  WhiteLilyDesktopApi,
} from "./desktopApi";
import type { Locale, MessageKey } from "./i18n/messageKeys";
import { HomePage } from "./pages/HomePage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { ModelPage } from "./pages/ModelPage";
import { AvatarModelPage } from "./pages/AvatarModelPage";
import {
  OnboardingPage,
  persistOnboardingLocale,
  readOnboardingLocale,
} from "./pages/OnboardingPage";
import { PersonaPage } from "./pages/PersonaPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorldSafetyPage } from "./pages/WorldSafetyPage";

interface AppProps {
  api?: WhiteLilyDesktopApi | WhiteLilyAppApi;
}

function App({ api }: AppProps) {
  const [locale, setLocale] = useState<Locale>(() => readOnboardingLocale());
  const [phase, setPhase] = useState<"checking" | "onboarding" | "main">("checking");
  const [route, setRoute] = useState<AppRoute>("home");
  const [activeNavigation, setActiveNavigation] = useState<MessageKey>("nav.home");
  const [ownerIdentity, setOwnerIdentity] = useState<OwnerIdentityAuthoritySnapshot | null>(null);
  const [ownerStateUnknown, setOwnerStateUnknown] = useState(false);
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
  const ownerChildGeneration = useRef(0);
  const ownerRevisionHighWater = useRef(-1);
  const ownerReadRequest = useRef(0);
  const ownerStateUnknownRef = useRef(false);
  const desktopApi = api ?? window.whiteLily;
  const task5Api = desktopApi as WhiteLilyAppApi;

  const enterOnboarding = useCallback(() => {
    ownerReadRequest.current += 1;
    ownerChildGeneration.current = 0;
    ownerRevisionHighWater.current = -1;
    ownerStateUnknownRef.current = false;
    setOwnerIdentity(null);
    setOwnerStateUnknown(false);
    setOwnerDialogOpen(false);
    setPhase("onboarding");
  }, []);
  const handleInitialSnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof desktopApi.status>>) => {
      if (snapshot.lifecycle === "running") {
        setPhase("main");
      } else {
        enterOnboarding();
      }
    },
    [enterOnboarding],
  );
  const handleConnectionInvalidated = enterOnboarding;
  const applyOwnerAuthority = useCallback(
    (
      snapshot: OwnerIdentityAuthoritySnapshot,
      source: "event" | "initial" | "reconciliation",
    ): boolean => {
      const currentGeneration = ownerChildGeneration.current;
      if (snapshot.childGeneration < currentGeneration) return false;
      const generationChanged = snapshot.childGeneration > currentGeneration;
      if (source === "event" && ownerStateUnknownRef.current && !generationChanged) {
        return false;
      }
      if (
        !generationChanged &&
        (snapshot.revision < ownerRevisionHighWater.current ||
          (source === "initial" && snapshot.revision === ownerRevisionHighWater.current))
      ) {
        return false;
      }
      ownerChildGeneration.current = snapshot.childGeneration;
      ownerRevisionHighWater.current = snapshot.revision;
      ownerStateUnknownRef.current = false;
      setOwnerStateUnknown(false);
      setOwnerIdentity(snapshot);
      return true;
    },
    [],
  );
  const handleOwnerIdentityChanged = useCallback(
    (snapshot: OwnerIdentitySnapshot): boolean =>
      applyOwnerAuthority(snapshot as OwnerIdentityAuthoritySnapshot, "reconciliation"),
    [applyOwnerAuthority],
  );
  const handleOwnerStateUnknownChanged = useCallback((unknown: boolean) => {
    ownerStateUnknownRef.current = unknown;
    if (unknown) ownerReadRequest.current += 1;
    setOwnerStateUnknown(unknown);
    if (unknown) setOwnerIdentity(null);
  }, []);

  useEffect(() => {
    if (phase !== "main") return;
    let active = true;
    const unsubscribe = desktopApi.subscribeOwnerIdentity((snapshot) => {
      if (!active) return;
      applyOwnerAuthority(snapshot as OwnerIdentityAuthoritySnapshot, "event");
    });
    const request = ++ownerReadRequest.current;
    void desktopApi.readOwnerIdentity().then(
      (snapshot) => {
        if (!active || ownerReadRequest.current !== request || ownerStateUnknownRef.current) return;
        applyOwnerAuthority(snapshot as OwnerIdentityAuthoritySnapshot, "initial");
      },
      () => undefined,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyOwnerAuthority, desktopApi, phase]);

  useEffect(() => {
    // Home owns the full runtime stream while mounted. Other pages need only
    // the authority-revocation signal so an invalid connection cannot leave
    // settings visible as if the session were still live.
    if (phase !== "main" || route === "home") return;
    return desktopApi.subscribeRuntime((event) => {
      if (event.kind === "connection_invalidated") handleConnectionInvalidated();
    });
  }, [desktopApi, handleConnectionInvalidated, phase, route]);

  const updateLocale = (nextLocale: Locale): void => {
    setLocale(nextLocale);
    persistOnboardingLocale(nextLocale);
  };

  if (phase === "onboarding") {
    return (
      <div className="onboarding-shell" lang={locale}>
        <header className="onboarding-topbar">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              WL
            </span>
            <div>
              <p className="brand-name">WhiteLily</p>
              <p className="brand-edition">Public Beta</p>
            </div>
          </div>
          <div className="onboarding-topbar-actions">
            <ApplicationExitButton api={desktopApi} locale={locale} />
            <button
              className="locale-button onboarding-locale-button"
              type="button"
              onClick={() => updateLocale(locale === "zh-CN" ? "en" : "zh-CN")}
            >
              <span aria-hidden="true">↔</span>
              {locale === "zh-CN" ? "English" : "中文"}
            </button>
          </div>
        </header>
        <OnboardingPage
          api={desktopApi}
          locale={locale}
          active
          onReady={(snapshot) => {
            if (snapshot.lifecycle === "running") {
              setRoute("home");
              setActiveNavigation("nav.home");
              setPhase("main");
            } else {
              enterOnboarding();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-shell" lang={locale}>
      <ApplicationExitButton api={desktopApi} locale={locale} />
      <Sidebar
        locale={locale}
        activeItem={activeNavigation}
        blocked={ownerDialogOpen}
        onNavigate={(nextRoute, item) => {
          if (ownerDialogOpen) return;
          setRoute(nextRoute);
          setActiveNavigation(item);
        }}
        onLocaleChange={(nextLocale) => {
          if (!ownerDialogOpen) updateLocale(nextLocale);
        }}
      />
      {route === "home" || phase === "checking" ? (
        <HomePage
          api={desktopApi}
          locale={locale}
          ownerIdentity={ownerIdentity}
          onInitialSnapshot={handleInitialSnapshot}
          onConnectionInvalidated={handleConnectionInvalidated}
        />
      ) : route === "persona" ? (
        <PersonaPage api={task5Api} locale={locale} />
      ) : route === "memory" ? (
        <MemoryPage api={task5Api} locale={locale} />
      ) : route === "worldSafety" ? (
        <WorldSafetyPage api={task5Api} locale={locale} ownerIdentity={ownerIdentity} />
      ) : route === "model" ? (
        <ModelPage api={desktopApi} locale={locale} />
      ) : route === "avatarModels" ? (
        <AvatarModelPage api={task5Api} locale={locale} />
      ) : route === "diagnostics" ? (
        <DiagnosticsPage api={task5Api} locale={locale} />
      ) : (
        <SettingsPage
          api={task5Api}
          locale={locale}
          ownerIdentity={ownerIdentity}
          ownerStateUnknown={ownerStateUnknown}
          onOwnerIdentityChange={handleOwnerIdentityChanged}
          onOwnerStateUnknownChange={handleOwnerStateUnknownChanged}
          onOwnerDialogOpenChange={setOwnerDialogOpen}
          onLocaleChange={updateLocale}
        />
      )}
    </div>
  );
}

export default App;
