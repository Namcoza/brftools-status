import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { isDatabaseReachable, listReleases, type Pool, type Release } from "./db.ts";
import { ago, detailList, escapeHtml, page } from "./html.ts";
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
  // When set, each Minecraft card links to its page in the admin menu.
  adminUrl?: string;
  now?: Date;
}

export function renderPage(
  currentVersion: string,
  releases: Release[],
  { minecraft = [], tailscale = null, adminUrl = "", now = new Date() }: PageSections = {},
): string {
  const rows = releases
    .map((release) => {
      const current = release.version === currentVersion ? ' class="current"' : "";
      return `<tr${current}><td>${escapeHtml(release.startedAt.toISOString())}</td><td>${versionHtml(release.version)}</td></tr>`;
    })
    .join("\n        ");

  const table = releases.length
    ? `<table>
      <thead><tr><th>Started (UTC)</th><th>Version</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`
    : "<p>No releases recorded yet.</p>";

  const minecraftSection = minecraft.length
    ? `<h2>Minecraft</h2>
    <div class="servers">
      ${minecraft.map((status) => serverCard(status, now, adminUrl)).join("\n      ")}
    </div>`
    : "";

  const tailscaleSection = tailscale
    ? `<h2>Tailscale</h2>
    <div class="servers">
      ${tailscaleCard(tailscale, now)}
    </div>`
    : "";

  const body = `<h1>brftools status</h1>
    ${minecraftSection}
    ${tailscaleSection}
    <h2>Release history</h2>
    <p>Running version ${versionHtml(currentVersion)}. Each row is one start of the app; rollbacks appear as an older version starting again.</p>
    ${table}`;
  return page({ title: "brftools status", body, refreshSeconds: 60 });
}

// Player counts only: names are deliberately never shown on this public page.
function serverCard({ server, state, checkedAt, result }: ServerStatus, now: Date, adminUrl: string): string {
  const title = (state === "online" && result?.motd) || server.name;
  const label = { unknown: "Checking…", online: "Online", offline: "Offline" }[state];
  const heading =
    adminUrl && server.id
      ? `<a class="card-link" href="${escapeHtml(`${adminUrl}/servers/${server.id}`)}">${escapeHtml(title)}</a>`
      : escapeHtml(title);

  const details: [string, string][] = [];
  if (state === "online" && result) {
    details.push(["Players", `${result.playersOnline} / ${result.playersMax}`]);
    if (result.version) details.push(["Version", escapeHtml(result.version)]);
  }
  if (server.join) details.push(["Join", escapeHtml(server.join)]);
  if (server.mapUrl) details.push(["Map", `<a href="${escapeHtml(server.mapUrl)}">Open the map</a>`]);

  const checked = checkedAt ? `Checked ${ago(checkedAt, now)} ago` : "Not checked yet";

  return `<section class="server">
        <h3>${heading}</h3>
        <span class="state ${state}">${label}</span>
        ${detailList(details)}
        <p class="checked">${checked}</p>
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
  const tone = state === "connected" ? "online" : state === "degraded" || state === "stale" ? "warning" : "offline";

  const details: [string, string][] = [];
  if (snapshot?.relay) details.push(["Relay", escapeHtml(snapshot.relay.toUpperCase())]);
  for (const warning of snapshot?.health ?? []) details.push(["Warning", escapeHtml(warning)]);
  if (snapshot?.error) details.push(["Error", escapeHtml(snapshot.error)]);

  const devices = snapshot?.peers.length
    ? `<ul class="devices">${snapshot.peers
        .map((peer) => {
          const presence = peer.online
            ? "online"
            : `offline${peer.lastSeen ? `, last seen ${ago(peer.lastSeen, now)} ago` : ""}`;
          const about = [peer.os, presence].filter(Boolean).map(escapeHtml).join(" · ");
          return `<li>${escapeHtml(peer.name)} <span>${about}</span></li>`;
        })
        .join("")}</ul>`
    : "";

  const updated = snapshot ? `Updated ${ago(snapshot.generatedAt, now)} ago` : "Status file missing or unreadable";

  return `<section class="server">
        <h3>This server</h3>
        <span class="state ${tone}">${label}</span>
        ${detailList(details)}
        ${devices}
        <p class="checked">${updated}</p>
      </section>`;
}

// A full commit SHA links to that commit; anything else (such as "dev") is plain text.
function versionHtml(version: string): string {
  const code = `<code>${escapeHtml(version)}</code>`;
  return /^[0-9a-f]{40}$/.test(version) ? `<a href="${COMMIT_URL}${version}">${code}</a>` : code;
}

function hostOf(req: IncomingMessage): string {
  return (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
