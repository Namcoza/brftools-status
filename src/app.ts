import { createServer, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { isDatabaseReachable, listReleases, type Pool, type Release } from "./db.ts";

export function createApp(config: Config, pool: Pool): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      // Healthy only when the database answers: the deploy script rolls back otherwise.
      if (req.method === "GET" && url.pathname === "/healthz") {
        const database = await isDatabaseReachable(pool);
        return sendJson(res, database ? 200 : 503, {
          status: database ? "ok" : "unavailable",
          version: config.appVersion,
          database: database ? "ok" : "unreachable",
        });
      }

      if (req.method === "GET" && url.pathname === "/") {
        const releases = await listReleases(pool);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(renderPage(config.appVersion, releases));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}

export function renderPage(currentVersion: string, releases: Release[]): string {
  const rows = releases
    .map((release) => {
      const current = release.version === currentVersion ? ' class="current"' : "";
      return `<tr${current}><td>${escapeHtml(release.startedAt.toISOString())}</td><td><code>${escapeHtml(release.version)}</code></td></tr>`;
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>brftools status</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 0 auto; padding: 4rem 1.25rem; line-height: 1.5; }
      h1 { margin: 0 0 0.25rem; }
      table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; font-size: 0.9rem; }
      th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
      tr.current td { font-weight: 600; }
      code { font-size: 0.85em; word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>Release history</h1>
    <p>Running version <code>${escapeHtml(currentVersion)}</code>. Each row is one start of the app; rollbacks appear as an older version starting again.</p>
    ${table}
  </body>
</html>
`;
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
