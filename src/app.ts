import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config, NavConfig } from "./config.ts";
import { isDatabaseReachable, listReleases, type Pool, type Release } from "./db.ts";
import { ago, detailList, escapeHtml, FAVICON_SVG, page, statusPill, type NavLinks, type Tone } from "./html.ts";
import type { ServerStatus } from "./minecraft.ts";
import type { TailscaleView } from "./tailscale.ts";

const COMMIT_URL = "https://github.com/Namcoza/brftools-status/commit/";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// Optional parts. Each page section is shown only when its source is configured.
export interface Sources {
  minecraft?: () => ServerStatus[];
  tailscale?: () => Promise<TailscaleView>;
  // The private admin menu handles every request whose Host is its hostname, and nothing else.
  admin?: { hostname: string; handle: Handler };
}

export function createApp(config: Config, pool: Pool, sources: Sources = {}): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (sources.admin && hostOf(req) === sources.admin.hostname) {
        return await sources.admin.handle(req, res);
      }

      if (req.method === "GET" && url.pathname === "/favicon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        return res.end(FAVICON_SVG);
      }

      // Healthy only when the database answers: the deploy script rolls back otherwise.
      // Minecraft and Tailscale state are reported for information and never change the
      // status code, so neither can roll this app back.
      if (req.method === "GET" && url.pathname === "/healthz") {
        const database = await isDatabaseReachable(pool);
        const servers = sources.minecraft?.() ?? [];
        const tailscale = await sources.tailscale?.();
        return sendJson(res, database ? 200 : 503, {
          status: database ? "ok" : "unavailable",
          version: config.appVersion,
          database: database ? "ok" : "unreachable",
          ...(servers.length > 0 && {
            minecraft: servers.map((status) => ({ name: status.server.name, state: status.state })),
          }),
          ...(tailscale && { tailscale: tailscale.state }),
        });
      }

      if (req.method === "GET" && url.pathname === "/") {
        const [releases, tailscale] = await Promise.all([listReleases(pool), sources.tailscale?.()]);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(
          renderPage(config.appVersion, releases, {
            minecraft: sources.minecraft?.() ?? [],
            tailscale: tailscale ?? null,
            adminUrl: sources.admin ? `https://${sources.admin.hostname}` : "",
            nav: config.nav,
          }),
        );
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      if (res.headersSent) return res.end();
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}

export interface PageSections {
  minecraft?: ServerStatus[];
  tailscale?: TailscaleView | null;
  // When set, each Minecraft card is a link to its page in the admin menu.
  adminUrl?: string;
  nav?: NavConfig;
  now?: Date;
}

export function renderPage(
  currentVersion: string,
  releases: Release[],
  { minecraft = [], tailscale = null, adminUrl = "", nav, now = new Date() }: PageSections = {},
): string {
  const rows = releases
    .map((release) => {
      const current = release.version === currentVersion ? ' class="current"' : "";
      return `<tr${current}><td>${escapeHtml(release.startedAt.toISOString().slice(0, 16).replace("T", " "))}</td><td>${versionHtml(release.version)}</td></tr>`;
    })
    .join("\n          ");

  const table = releases.length
    ? `<table class="table">
        <thead><tr><th>Started (UTC)</th><th>Version</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table>`
    : "<p>No releases recorded yet.</p>";

  const minecraftSection = minecraft.length
    ? `<h2>Minecraft</h2>
      <div class="cards">
        ${minecraft.map((status) => serverCard(status, now, adminUrl)).join("\n        ")}
      </div>`
    : "";

  const tailscaleSection = tailscale
    ? `<h2>Remote access</h2>
      <div class="cards">
        ${tailscaleCard(tailscale, now)}
      </div>`
    : "";

  const body = `<h1>brftools status</h1>
      <p class="meta">Refreshed every 60 seconds.</p>
      ${minecraftSection}
      ${tailscaleSection}
      <h2>Release history</h2>
      <p>Running version ${versionHtml(currentVersion)}. Each row is one start of the app; a rollback appears as an older version starting again.</p>
      ${table}`;

  return page({
    title: "brftools status",
    body,
    refreshSeconds: 60,
    nav: navLinks(nav),
    faviconUrl: "/favicon.svg",
  });
}

function navLinks(nav?: NavConfig): NavLinks {
  return { status: nav?.statusUrl || "/", games: nav?.gamesUrl ?? "", map: nav?.mapUrl ?? "" };
}

// Player counts only: names are deliberately never shown on this public page.
function serverCard({ server, state, checkedAt, result }: ServerStatus, now: Date, adminUrl: string): string {
  const title = (state === "online" && result?.motd) || server.name;
  const tone: Tone = state === "online" ? "ok" : state === "offline" ? "bad" : "idle";
  const label = { unknown: "Checking…", online: "Online", offline: "Offline" }[state];
  const heading =
    adminUrl && server.id
      ? `<a class="cover" href="${escapeHtml(`${adminUrl}/servers/${server.id}`)}">${escapeHtml(title)}</a>`
      : escapeHtml(title);

  const details: [string, string][] = [];
  if (state === "online" && result) {
    details.push(["Players", `${result.playersOnline} / ${result.playersMax}`]);
    if (result.version) details.push(["Version", escapeHtml(result.version)]);
  }
  if (server.join) details.push(["Join", escapeHtml(server.join)]);
  if (server.mapUrl) details.push(["Map", `<a href="${escapeHtml(server.mapUrl)}">Open the map</a>`]);

  const checked = checkedAt ? `Checked ${ago(checkedAt, now)} ago` : "Not checked yet";

  return `<section class="card">
          <div class="card-head"><h3>${heading}</h3>${statusPill(tone, label)}</div>
          ${detailList(details)}
          <p class="meta">${checked}</p>
        </section>`;
}

const BACKEND_STATES: Record<string, string> = {
  NoState: "Not running",
  Starting: "Starting",
  NeedsLogin: "Needs login",
  NeedsMachineAuth: "Needs approval in the admin console",
  Stopped: "Stopped",
  Unavailable: "Not responding",
};

// Device names are shown by decision. Addresses and tailnet names never reach the snapshot.
function tailscaleCard({ state, snapshot }: TailscaleView, now: Date): string {
  const backendState = snapshot?.backendState ?? "";
  const label =
    state === "connected"
      ? "Connected"
      : state === "degraded"
        ? "Connected, with warnings"
        : state === "stale"
          ? "No recent update"
          : state === "missing"
            ? "No data"
            : backendState === "Running"
              ? "Not connected to Tailscale"
              : (BACKEND_STATES[backendState] ?? (backendState || "Down"));
  const tone: Tone = state === "connected" ? "ok" : state === "degraded" || state === "stale" ? "warn" : "bad";

  const details: [string, string][] = [];
  if (snapshot?.relay) details.push(["Relay", escapeHtml(snapshot.relay.toUpperCase())]);
  for (const warning of snapshot?.health ?? []) details.push(["Warning", escapeHtml(warning)]);
  if (snapshot?.error) details.push(["Error", escapeHtml(snapshot.error)]);

  // Folded to a count by default, so a phone shows the state first.
  const peers = snapshot?.peers ?? [];
  const online = peers.filter((peer) => peer.online).length;
  const devices = peers.length
    ? `<details class="above">
            <summary>${peers.length} ${peers.length === 1 ? "device" : "devices"} · ${online} online</summary>
            <ul class="devices">${peers
              .map((peer) => {
                const presence = peer.online
                  ? "online"
                  : `offline${peer.lastSeen ? `, last seen ${ago(peer.lastSeen, now)} ago` : ""}`;
                const about = [peer.os, presence].filter(Boolean).map(escapeHtml).join(" · ");
                return `<li><span>${escapeHtml(peer.name)}</span><span class="who">${about}</span></li>`;
              })
              .join("")}</ul>
          </details>`
    : "";

  const updated = snapshot ? `Updated ${ago(snapshot.generatedAt, now)} ago` : "Status file missing or unreadable";

  return `<section class="card">
          <div class="card-head"><h3>This server</h3>${statusPill(tone, label)}</div>
          ${detailList(details)}
          ${devices}
          <p class="meta">${updated}</p>
        </section>`;
}

// A full commit SHA links to that commit; anything else (such as "dev") is plain text.
function versionHtml(version: string): string {
  const shortened = /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
  const code = `<code>${escapeHtml(shortened)}</code>`;
  return /^[0-9a-f]{40}$/.test(version) ? `<a href="${COMMIT_URL}${version}">${code}</a>` : code;
}

function hostOf(req: IncomingMessage): string {
  return (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
