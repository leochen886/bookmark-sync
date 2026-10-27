export type BrowserKind = "chrome" | "ego";

export interface ExtensionSettings {
  relayUrl: string;
  token: string;
  browser: BrowserKind;
  profileLabel: string;
  installId: string;
  paused: boolean;
  paired: boolean;
}

const SETTINGS_KEY = "settings";
const DEFAULT_RELAY_URL = "ws://127.0.0.1:8787/ws";

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>;
  const installId =
    typeof raw.installId === "string" && raw.installId.length > 0
      ? raw.installId
      : crypto.randomUUID();

  const settings: ExtensionSettings = {
    relayUrl:
      typeof raw.relayUrl === "string" && raw.relayUrl.length > 0
        ? raw.relayUrl
        : DEFAULT_RELAY_URL,
    token: typeof raw.token === "string" ? raw.token : "",
    browser: raw.browser === "ego" ? "ego" : "chrome",
    profileLabel:
      typeof raw.profileLabel === "string" && raw.profileLabel.length > 0
        ? raw.profileLabel
        : "default",
    installId,
    paused: raw.paused === true,
    paired: raw.paired === true,
  };

  if (raw.installId !== installId) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
  return settings;
}

export async function saveSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next: ExtensionSettings = {
    ...current,
    ...patch,
    installId: current.installId,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function endpointIdFor(settings: ExtensionSettings): string {
  return `${settings.installId}:${settings.browser}:${settings.profileLabel}`;
}

export function relayHealthUrl(relayUrl: string): string {
  try {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "http://127.0.0.1:8787/health";
  }
}
