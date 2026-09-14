import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, renderPage } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createPool, listReleases, migrate, recordRelease, type Pool } from "../src/db.ts";
import type { MinecraftServerConfig, ServerStatus } from "../src/minecraft.ts";
import type { TailscaleSnapshot, TailscaleView } from "../src/tailscale.ts";

const family: MinecraftServerConfig = {
  name: "Family",
  host: "family.example",
  port: 25565,
  join: "Java family.example:25565",
  mapUrl: "https://map.example/",
};
const crossplay: MinecraftServerConfig = { name: "Crossplay", host: "crossplay.example", port: 25565, join: "", mapUrl: "" };
const offline: ServerStatus[] = [{ server: family, state: "offline", checkedAt: null, result: null }];

const migrationsDir = new URL("../migrations/", import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";

// CI always provides a database. Locally, database tests are skipped with a reason.
const skipDatabase = databaseUrl || process.env.CI ? false : "TEST_DATABASE_URL is not set";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("renderPage", () => {
  test("escapes values and marks the running version", () => {
    const html = renderPage("abc", [
      { version: "abc", startedAt: new Date("2026-09-13T10:00:00Z") },
      { version: "<script>", startedAt: new Date("2026-09-12T10:00:00Z") },
    ]);
    assert.match(html, /<tr class="current"><td>2026-09-13T10:00:00.000Z<\/td><td><code>abc<\/code>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  test("shows an empty state", () => {
    assert.match(renderPage("abc", []), /No releases recorded yet/);
  });

  test("links full commit SHAs to the commit, and nothing else", () => {
    const sha = "2ad0e8538975fb97ae7f66cf55c0f83e3de8febd";
    const html = renderPage(sha, [{ version: sha, startedAt: new Date("2026-09-13T10:00:00Z") }]);
    const link = `<a href="https://github.com/Namcoza/brftools-status/commit/${sha}"><code>${sha}</code></a>`;
    assert.equal(html.split(link).length - 1, 2, "running version and table row are both linked");
    assert.doesNotMatch(renderPage("dev", []), /<a href=/);
  });

  test("omits the Minecraft section when no servers are configured", () => {
    assert.doesNotMatch(renderPage("dev", []), /Minecraft/);
  });

  test("shows each Minecraft server's state, counts, version, join address and map", () => {
    const now = new Date("2026-09-14T12:00:30Z");
    const html = renderPage("dev", [], {
      minecraft: [
        {
          server: family,
          state: "online",
          checkedAt: new Date("2026-09-14T12:00:18Z"),
          result: { motd: "Family Server", version: "26.2", playersOnline: 3, playersMax: 20 },
        },
        { server: crossplay, state: "offline", checkedAt: new Date("2026-09-14T12:00:25Z"), result: null },
      ],
      now,
    });
    assert.match(html, /<h2>Minecraft<\/h2>/);
    assert.match(html, /<h3>Family Server<\/h3>\s*<span class="state online">Online<\/span>/);
    assert.match(html, /<dt>Players<\/dt><dd>3 \/ 20<\/dd><dt>Version<\/dt><dd>26.2<\/dd>/);
    assert.match(html, /<dt>Join<\/dt><dd>Java family.example:25565<\/dd>/);
    assert.match(html, /<a href="https:\/\/map.example\/">Open the map<\/a>/);
    assert.match(html, /Checked 12 s ago/);
    // Offline: falls back to the configured name, and shows no stale counts.
    assert.match(html, /<h3>Crossplay<\/h3>\s*<span class="state offline">Offline<\/span>\s*<p class="checked">Checked 5 s ago/);
    assert.ok(html.indexOf("<h2>Minecraft</h2>") < html.indexOf("<h2>Release history</h2>"));
  });

  test("escapes values reported by a Minecraft server", () => {
    const html = renderPage("dev", [], {
      minecraft: [
        {
          server: crossplay,
          state: "online",
          checkedAt: null,
          result: { motd: "<img src=x onerror=alert(1)>", version: '"><script>', playersOnline: 0, playersMax: 20 },
        },
      ],
    });
    assert.match(html, /<h3>&lt;img src=x onerror=alert\(1\)&gt;<\/h3>/);
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /Not checked yet/);
  });
});

describe("renderPage: Tailscale", () => {
  const now = new Date("2026-09-14T12:10:00Z");
  const snapshot: TailscaleSnapshot = {
    generatedAt: new Date("2026-09-14T12:09:30Z"),
    backendState: "Running",
    error: "",
    online: true,
    health: [],
    relay: "lhr",
    peers: [
      { name: "laptop-example", os: "macOS", online: true, lastSeen: null },
      { name: "phone-example", os: "iOS", online: false, lastSeen: new Date("2026-09-14T11:45:00Z") },
    ],
  };

  test("omits the section when not configured", () => {
    assert.doesNotMatch(renderPage("dev", []), /Tailscale/);
  });

  test("shows a connected host with its relay and devices, above the release history", () => {
    const html = renderPage("dev", [], { tailscale: { state: "connected", snapshot }, now });
    assert.match(html, /<h2>Tailscale<\/h2>/);
    assert.match(html, /<span class="state online">Connected<\/span>/);
    assert.match(html, /<dt>Relay<\/dt><dd>LHR<\/dd>/);
    assert.match(html, /<li>laptop-example <span>macOS · online<\/span><\/li>/);
    assert.match(html, /<li>phone-example <span>iOS · offline, last seen 25 min ago<\/span><\/li>/);
    assert.match(html, /Updated 30 s ago/);
    assert.ok(html.indexOf("<h2>Tailscale</h2>") < html.indexOf("<h2>Release history</h2>"));
  });

  test("lists health warnings, escaped", () => {
    const html = renderPage("dev", [], {
      tailscale: { state: "degraded", snapshot: { ...snapshot, health: ["<b>DNS</b> unreachable"] } },
      now,
    });
    assert.match(html, /<span class="state warning">Connected, with warnings<\/span>/);
    assert.match(html, /<dt>Warning<\/dt><dd>&lt;b&gt;DNS&lt;\/b&gt; unreachable<\/dd>/);
    assert.doesNotMatch(html, /<b>/);
  });

  test("names the reason when down, stale or missing", () => {
    const page = (tailscale: TailscaleView) => renderPage("dev", [], { tailscale, now });
    assert.match(
      page({ state: "down", snapshot: { ...snapshot, backendState: "NeedsLogin", online: false } }),
      /<span class="state offline">Needs login<\/span>/,
    );
    assert.match(page({ state: "down", snapshot: { ...snapshot, online: false } }), /Not connected to Tailscale/);
    assert.match(
      page({
        state: "down",
        snapshot: { ...snapshot, backendState: "Unavailable", online: false, error: "tailscale status failed (exit 1)", relay: "", peers: [] },
      }),
      /Not responding<\/span>\s*<dl><dt>Error<\/dt><dd>tailscale status failed \(exit 1\)<\/dd><\/dl>/,
    );
    assert.match(
      page({ state: "stale", snapshot: { ...snapshot, generatedAt: new Date("2026-09-14T11:10:00Z") } }),
      /<span class="state warning">No recent update<\/span>[\s\S]*Updated 60 min ago/,
    );
    assert.match(
      page({ state: "missing", snapshot: null }),
      /<span class="state offline">No data<\/span>[\s\S]*Status file missing or unreadable/,
    );
  });
});

describe("with a database", { skip: skipDatabase }, () => {
  let pool: Pool;
  let server: Server;
  let baseUrl = "";

  before(async () => {
    // The tests drop tables, so refuse anything that is not obviously a test database.
    if (!new URL(databaseUrl).pathname.includes("test")) {
      throw new Error("TEST_DATABASE_URL must name a database containing 'test'");
    }
    pool = createPool(databaseUrl);
    await pool.query("DROP TABLE IF EXISTS releases, schema_migrations");
    // Every Minecraft server is offline and there is no Tailscale data: the app must still report healthy.
    server = createApp(loadConfig({ DATABASE_URL: databaseUrl, APP_VERSION: "test-sha" }), pool, {
      minecraft: () => offline,
      tailscale: async () => ({ state: "missing", snapshot: null }),
    });
    baseUrl = await listen(server);
  });

  after(async () => {
    server.close();
    await pool.end();
  });

  test("migrations apply once and are idempotent", async () => {
    assert.deepEqual(await migrate(pool, migrationsDir), ["001_create_releases.sql"]);
    assert.deepEqual(await migrate(pool, migrationsDir), []);
  });

  test("releases are listed newest first", async () => {
    await recordRelease(pool, "older-sha");
    await recordRelease(pool, "test-sha");
    const releases = await listReleases(pool);
    assert.deepEqual(
      releases.map((release) => release.version),
      ["test-sha", "older-sha"],
    );
  });

  test("GET /healthz reports ok while Minecraft is offline and Tailscale data is missing", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      version: "test-sha",
      database: "ok",
      minecraft: [{ name: "Family", state: "offline" }],
      tailscale: "missing",
    });
  });

  test("GET / lists the release history", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /test-sha/);
    assert.match(html, /older-sha/);
    assert.match(html, /<span class="state offline">Offline<\/span>/);
    assert.match(html, /<span class="state offline">No data<\/span>/);
  });

  test("unknown paths return 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

describe("without a database", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl = "";

  before(async () => {
    pool = createPool("postgres://postgres@127.0.0.1:1/unreachable_test");
    server = createApp(loadConfig({ DATABASE_URL: "postgres://unused/test", APP_VERSION: "test-sha" }), pool);
    baseUrl = await listen(server);
  });

  after(async () => {
    server.close();
    await pool.end();
  });

  test("GET /healthz returns 503 so a bad release is rolled back", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: "unavailable", version: "test-sha", database: "unreachable" });
  });
});
