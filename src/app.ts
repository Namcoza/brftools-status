import { createServer, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { isDatabaseReachable, listReleases, type Pool, type Release } from "./db.ts";
import type { ServerStatus } from "./minecraft.ts";

const COMMIT_URL = "https://github.com/Namcoza/brftools-status/commit/";

export function createApp(config: Config, pool: Pool, minecraft: () => ServerStatus[] = () => []): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      // Healthy only when the database answers: the deploy script rolls back otherwise.
      // Minecraft state is reported for information and never changes the status code,
      // so a game server restart cannot roll this app back.
      if (req.method === "GET" && url.pathname === "/healthz") {
        const database = await isDatabaseReachable(pool);
        const servers = minecraft();
        return sendJson(res, database ? 200 : 503, {
          status: database ? "ok" : "unavailable",
          version: config.appVersion,
          database: database ? "ok" : "unreachable",
          ...(servers.length > 0 && {
            minecraft: servers.map((status) => ({ name: status.server.name, state: status.state })),
          }),
        });
      }

      if (req.method === "GET" && url.pathname === "/") {
        const releases = await listReleases(pool);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(renderPage(config.appVersion, releases, minecraft()));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}

export function renderPage(
  currentVersion: string,
  releases: Release[],
  minecraft: ServerStatus[] = [],
  now: Date = new Date(),
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
      ${minecraft.map((status) => serverCard(status, now)).join("\n      ")}
    </div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="60" />
    <title>brftools status</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 0 auto; padding: 4rem 1.25rem; line-height: 1.5; }
      h1 { margin: 0 0 0.25rem; }
      h2 { margin: 2rem 0 0.25rem; font-size: 1.25rem; }
      table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; font-size: 0.9rem; }
      th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
      tr.current td { font-weight: 600; }
      code { font-size: 0.85em; word-break: break-all; }
      a { color: inherit; }
      .servers { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); margin-top: 1rem; }
      .server { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 0.5rem; padding: 0.75rem 1rem; }
      .server h3 { margin: 0; font-size: 1rem; }
      .state { font-size: 0.85rem; font-weight: 600; }
      .state.online::before, .state.offline::before { content: "● "; }
      .state.online::before { color: #2e9e55; }
      .state.offline::before { color: #d9534f; }
      .server dl { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0.5rem 0; font-size: 0.9rem; }
      .server dt { opacity: 0.7; }
      .server dd { margin: 0; overflow-wrap: anywhere; }
      .checked { margin: 0; font-size: 0.8rem; opacity: 0.7; }
    </style>
  </head>
  <body>
    <h1>brftools status</h1>
    ${minecraftSection}
    <h2>Release history</h2>
    <p>Running version ${versionHtml(currentVersion)}. Each row is one start of the app; rollbacks appear as an older version starting again.</p>
    ${table}
  </body>
</html>
`;
}

// Player counts only: names are deliberately never shown on this public page.
function serverCard({ server, state, checkedAt, result }: ServerStatus, now: Date): string {
  const title = (state === "online" && result?.motd) || server.name;
  const label = { unknown: "Checking…", online: "Online", offline: "Offline" }[state];

  const details: [string, string][] = [];
  if (state === "online" && result) {
    details.push(["Players", `${result.playersOnline} / ${result.playersMax}`]);
    if (result.version) details.push(["Version", escapeHtml(result.version)]);
  }
  if (server.join) details.push(["Join", escapeHtml(server.join)]);
  if (server.mapUrl) details.push(["Map", `<a href="${escapeHtml(server.mapUrl)}">Open the map</a>`]);

  const checked = checkedAt
    ? `Checked ${Math.max(0, Math.round((now.getTime() - checkedAt.getTime()) / 1000))} s ago`
    : "Not checked yet";

  return `<section class="server">
        <h3>${escapeHtml(title)}</h3>
        <span class="state ${state}">${label}</span>
        ${details.length ? `<dl>${details.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>` : ""}
        <p class="checked">${checked}</p>
      </section>`;
}

// A full commit SHA links to that commit; anything else (such as "dev") is plain text.
function versionHtml(version: string): string {
  const code = `<code>${escapeHtml(version)}</code>`;
  return /^[0-9a-f]{40}$/.test(version) ? `<a href="${COMMIT_URL}${version}">${code}</a>` : code;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
