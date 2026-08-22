import { useEffect, useRef, useState } from "react";
import type { WhiteLilyDesktopApi } from "../desktopApi.js";
import type { Locale } from "../i18n/messageKeys.js";
import { translate } from "../i18n/translator.js";

interface ApplicationExitButtonProps {
  api: Pick<WhiteLilyDesktopApi, "quitApplication">;
  locale: Locale;
}

export function ApplicationExitButton({ api, locale }: ApplicationExitButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const quit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.quitApplication();
    } catch {
      if (!mounted.current) return;
      setBusy(false);
      setFailed(true);
    }
  };

  return (
    <div className="application-exit-control">
      <button
        className="application-exit-button"
        type="button"
        disabled={busy}
        onClick={() => void quit()}
      >
        {translate(locale, busy ? "app.quitting" : "app.quit")}
      </button>
      {failed ? (
        <span className="application-exit-error" role="status">
          {translate(locale, "app.quitFailed")}
        </span>
      ) : null}
    </div>
  );
}
