import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import type { Config } from "./config.ts";

export function createApp(config: Config): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { status: "ok", version: config.appVersion });
      }

      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(join(config.publicDir, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
