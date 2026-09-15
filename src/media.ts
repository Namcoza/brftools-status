// Read-only health checks for the media services (Plex, Sonarr, Radarr, SABnzbd,
// Audiobookshelf). Every endpoint answers without an API key or login, and this app never holds
// one: it reads state and nothing else. See README, "Media section".
//
// Addresses live only in production configuration and are never rendered on the public page —
// a card there links to the admin menu, which reveals the address after Cloudflare Access.

export type MediaKind = "plex" | "arr" | "sabnzbd" | "audiobookshelf";

export const MEDIA_KINDS: MediaKind[] = ["plex", "arr", "sabnzbd", "audiobookshelf"];

export interface MediaServiceConfig {
  id: string;
  name: string;
  kind: MediaKind;
  checkUrl: string;
  // Where /open/<id> sends a signed-in browser, and the alternative listed beside it.
  url: string;
  lanUrl: string;
}

export interface MediaResult {
  version: string;
  // Audiobookshelf before its admin account exists: up, but not usable yet.
  setupIncomplete: boolean;
}

export interface MediaStatus {
  service: MediaServiceConfig;
  state: "unknown" | "up" | "down";
  checkedAt: Date | null;
  result: MediaResult | null;
}

export type MediaCheck = (service: MediaServiceConfig, timeoutMs: number) => Promise<MediaResult>;

// Responses are small; anything larger is a sign we are talking to the wrong thing.
const MAX_BODY_BYTES = 64 * 1024;

export function parsePlex(body: string): MediaResult {
  // Scoped to the MediaContainer tag: the XML declaration also carries a version attribute.
  const container = /<MediaContainer\b[^>]{0,2048}>/.exec(body)?.[0] ?? "";
  const version = /\sversion="([^"]{0,64})"/.exec(container)?.[1] ?? "";
  // Plex reports 1.43.4.10903-e5521bd8c; the build hash is noise on a status page.
  return { version: version.split("-")[0] ?? "", setupIncomplete: false };
}

// Sonarr and Radarr: /ping needs no key, but the version does — so up or down only.
export function parseArr(body: string): MediaResult {
  const status = (JSON.parse(body) ?? {}) as { status?: unknown };
  if (status.status !== "OK") throw new Error("ping did not report OK");
  return { version: "", setupIncomplete: false };
}

export function parseSabnzbd(body: string): MediaResult {
  const parsed = (JSON.parse(body) ?? {}) as { version?: unknown };
  return { version: typeof parsed.version === "string" ? parsed.version : "", setupIncomplete: false };
}

// /status also returns ConfigPath and MetadataPath; both are dropped here, so they cannot reach
// a page by accident.
export function parseAudiobookshelf(body: string): MediaResult {
  const parsed = (JSON.parse(body) ?? {}) as { serverVersion?: unknown; isInit?: unknown };
  return {
    version: typeof parsed.serverVersion === "string" ? parsed.serverVersion : "",
    setupIncomplete: parsed.isInit === false,
  };
}

const PARSERS: Record<MediaKind, (body: string) => MediaResult> = {
  plex: parsePlex,
  arr: parseArr,
  sabnzbd: parseSabnzbd,
  audiobookshelf: parseAudiobookshelf,
};

export const checkService: MediaCheck = async (service, timeoutMs) => {
  const response = await fetch(service.checkUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json, text/xml, */*" },
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const body = (await response.text()).slice(0, MAX_BODY_BYTES);
  return PARSERS[service.kind](body);
};

export interface MediaMonitor {
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
  statuses(): MediaStatus[];
}

// The same shape as the Minecraft monitor: poll on an interval, keep the latest result in memory,
// so a page view never waits on a service and one slow service cannot delay another.
export function createMediaMonitor(
  services: MediaServiceConfig[],
  { check = checkService, intervalMs = 30_000, timeoutMs = 3_000, now = () => new Date() } = {},
): MediaMonitor {
  let statuses: MediaStatus[] = services.map((service) => ({ service, state: "unknown", checkedAt: null, result: null }));
  let timer: NodeJS.Timeout | undefined;

  async function poll(previous: MediaStatus): Promise<MediaStatus> {
    const { service } = previous;
    try {
      const result = await check(service, timeoutMs);
      if (previous.state !== "up") console.log(`media "${service.name}": up`);
      return { service, state: "up", checkedAt: now(), result };
    } catch (error) {
      if (previous.state !== "down") console.log(`media "${service.name}": down (${(error as Error).message})`);
      return { service, state: "down", checkedAt: now(), result: null };
    }
  }

  async function refresh(): Promise<void> {
    statuses = await Promise.all(statuses.map(poll));
  }

  return {
    refresh,
    start() {
      if (timer || services.length === 0) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    statuses: () => statuses,
  };
}
