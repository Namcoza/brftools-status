import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { isDatabaseReachable, listReleases, type Pool } from "./db.ts";
import { FAVICON_SVG } from "./html.ts";
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
          adminUrl: sources.admin ? `https://${sources.admin.hostname}` : "",
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
