import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { isDatabaseReachable, listReleases, type Pool } from "./db.ts";
import type { StatusGate } from "./gate.ts";
import { escapeHtml, FAVICON_SVG, glyph, page } from "./html.ts";
import { parseSection, renderHome, type HomeData, type MediaFilter, type MediaView } from "./home.ts";
import type { MediaStatus } from "./media.ts";
import type { ServerStatus } from "./minecraft.ts";
import type { TailscaleView } from "./tailscale.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// Optional parts. Each page section is shown only when its source is configured.
export interface Sources {
  minecraft?: () => ServerStatus[];
  media?: () => MediaStatus[];
  tailscale?: () => Promise<TailscaleView>;
  // The private admin menu handles every request whose Host is its hostname, and nothing else.
  admin?: { hostname: string; handle: Handler };
  // Sign-in for the status page. Unset leaves it public.
  gate?: StatusGate;
}

const MEDIA_GROUPS: MediaFilter[] = ["play", "lib", "fetch"];

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
        const media = sources.media?.() ?? [];
        const tailscale = await sources.tailscale?.();
        return sendJson(res, database ? 200 : 503, {
          status: database ? "ok" : "unavailable",
          version: config.appVersion,
          database: database ? "ok" : "unreachable",
          ...(servers.length > 0 && {
            minecraft: servers.map((status) => ({ name: status.server.name, state: status.state })),
          }),
          ...(media.length > 0 && {
            media: media.map((status) => ({ name: status.service.name, state: status.state })),
          }),
          ...(tailscale && { tailscale: tailscale.state }),
        });
      }

      // Everything below needs a signed-in, invited visitor when sign-in is on. /healthz stays
      // open above: the container health check and automatic rollback depend on it.
      const visitor = sources.gate ? await sources.gate.check(req) : null;
      if (visitor?.kind === "anonymous") {
        console.error(`status: refused ${req.method} ${JSON.stringify(req.url)}: ${visitor.reason}`);
        return sendHtml(res, 403, refusalPage(config, "Sign in required", "<p>Open the status page through its usual address to sign in with Google.</p>"));
      }
      if (visitor?.kind === "uninvited") {
        console.log(`status: refused ${JSON.stringify(visitor.email)}: not invited`);
        return sendHtml(
          res,
          403,
          refusalPage(
            config,
            "Not invited",
            `<p>You are signed in as <strong>${escapeHtml(visitor.email)}</strong>, which has not been invited to this page. Ask the owner to invite this Google account.</p>
      <div class="actions"><a class="btn" href="/cdn-cgi/access/logout">Sign out and use another account</a></div>`,
          ),
        );
      }

      const section = req.method === "GET" ? parseSection(url.pathname) : null;
      if (section) {
        const [releases, tailscale] = await Promise.all([listReleases(pool), sources.tailscale?.()]);
        const group = url.searchParams.get("group") ?? "all";
        const mediaFilter: MediaFilter = MEDIA_GROUPS.includes(group as MediaFilter) ? (group as MediaFilter) : "all";
        const mediaView: MediaView = url.searchParams.get("view") === "table" ? "table" : "cards";

        const data: HomeData = {
          section,
          currentVersion: config.appVersion,
          minecraft: sources.minecraft?.() ?? [],
          media: sources.media?.() ?? [],
          tailscale: tailscale ?? null,
          releases,
          facts: config.homeFacts,
          // "Open" links go through the owner-only admin menu, so only the owner gets them.
          adminUrl: sources.admin && (!visitor || visitor.kind === "owner") ? `https://${sources.admin.hostname}` : "",
          nav: config.nav,
          now: new Date(),
          mediaFilter,
          mediaView,
        };
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(renderHome(data));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      if (res.headersSent) return res.end();
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}

function hostOf(req: IncomingMessage): string {
  return (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
}

function refusalPage(config: Config, title: string, html: string): string {
  const { statusUrl, gamesUrl, mapUrl } = config.nav;
  const body = `<p class="state bad">${glyph("bad")}</p>
      <h1>${escapeHtml(title)}</h1>
      ${html}`;
  return page({ title: `${title} · brftools`, body, nav: { status: statusUrl || "/", games: gamesUrl, map: mapUrl }, faviconUrl: "/favicon.svg" });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
