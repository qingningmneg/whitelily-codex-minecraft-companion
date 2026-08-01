const GITHUB_ORIGIN = "https://github.com";
const REPOSITORY_PATH = "/qingningmneg/whitelily-codex-minecraft-companion";
const ENCODED_SEPARATOR = /%2f|%5c/iu;

export interface ExternalNavigationEvent {
  preventDefault(): void;
}

export interface ExternalUrlHandlers {
  openWindow(details: { url: string }): { action: "deny" };
  navigate(event: ExternalNavigationEvent, url: string): void;
}

export class ExternalUrlPolicy {
  #activeCodexLoginUrl: string | undefined;

  canOpen(value: string): boolean {
    const url = parseHttpsUrl(value);
    if (!url) return false;
    if (isAllowedRepositoryUrl(url)) return true;
    return url.href === this.#activeCodexLoginUrl;
  }

  setActiveCodexLoginUrl(value: string): void {
    const url = parseHttpsUrl(value);
    if (!url || !isCodexLoginOrigin(url)) throw new Error("invalid Codex login URL");
    this.#activeCodexLoginUrl = url.href;
  }

  clearActiveCodexLoginUrl(): void {
    this.#activeCodexLoginUrl = undefined;
  }
}

export function createExternalUrlHandlers(
  policy: ExternalUrlPolicy,
  openExternal: (url: string) => void | Promise<unknown>,
): ExternalUrlHandlers {
  const openIfAllowed = (url: string): void => {
    if (!policy.canOpen(url)) return;
    try {
      void Promise.resolve(openExternal(url)).catch(() => undefined);
    } catch {
      // System-shell failures cannot relax or bypass the URL decision.
    }
  };
  return {
    openWindow: ({ url }) => {
      openIfAllowed(url);
      return { action: "deny" };
    },
    navigate: (event, url) => {
      event.preventDefault();
      openIfAllowed(url);
    },
  };
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    if (value.includes("\\")) return undefined;
    const authorityMatch = /^https:\/\/([^/?#]*)/iu.exec(value);
    if (!authorityMatch) return undefined;
    const authority = authorityMatch[1]!;
    if (authority.includes(":")) return undefined;
    const rawPath = value.slice(authorityMatch[0].length).split(/[?#]/u, 1)[0]!;
    if (ENCODED_SEPARATOR.test(rawPath)) return undefined;
    for (const segment of rawPath.split("/")) {
      const decodedSegment = decodeURIComponent(segment);
      if (decodedSegment === "." || decodedSegment === "..") return undefined;
    }
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isAllowedRepositoryUrl(url: URL): boolean {
  if (url.origin !== GITHUB_ORIGIN) return false;
  const path = removeTrailingSlash(url.pathname);
  return path === REPOSITORY_PATH || path === `${REPOSITORY_PATH}/releases`
    ? true
    : path.startsWith(`${REPOSITORY_PATH}/releases/`);
}

function isCodexLoginOrigin(url: URL): boolean {
  return (
    isDomainOrSubdomain(url.hostname, "openai.com") ||
    isDomainOrSubdomain(url.hostname, "chatgpt.com")
  );
}

function isDomainOrSubdomain(hostname: string, parent: string): boolean {
  const lowerHostname = hostname.toLowerCase();
  return lowerHostname === parent || lowerHostname.endsWith(`.${parent}`);
}

function removeTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
