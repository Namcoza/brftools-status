import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, renderPage } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createPool, listReleases, migrate, recordRelease, type Pool } from "../src/db.ts";
import type { MinecraftServerConfig, ServerStatus } from "../src/minecraft.ts";
import type { MediaStatus } from "../src/media.ts";
import type { TailscaleSnapshot, TailscaleView } from "../src/tailscale.ts";
import { listenOn, send } from "./http-helper.ts";

const family: MinecraftServerConfig = {
  id: "family",
  name: "Family",
  host: "family.example",
  port: 25565,
  join: "Java family.example:25565",
  mapUrl: "https://map.example/",
};
const crossplay: MinecraftServerConfig = { id: "crossplay", name: "Crossplay", host: "crossplay.example", port: 25565, join: "", mapUrl: "" };
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
    assert.match(html, /<tr class="current"><td>2026-09-13 10:00<\/td><td><code>abc<\/code>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  test("shows an empty state", () => {
    assert.match(renderPage("abc", []), /No releases recorded yet/);
  });

  test("links full commit SHAs to the commit, and nothing else", () => {
    const sha = "2ad0e8538975fb97ae7f66cf55c0f83e3de8febd";
    const html = renderPage(sha, [{ version: sha, startedAt: new Date("2026-09-13T10:00:00Z") }]);
    // The full SHA is the link; the short form is what the reader sees.
    const link = `<a href="https://github.com/Namcoza/brftools-status/commit/${sha}"><code>2ad0e85</code></a>`;
    assert.equal(html.split(link).length - 1, 2, "running version and table row are both linked");
    assert.doesNotMatch(renderPage("dev", []), /commit\//);
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
          result: { motd: "Family Server", version: "26.2", playersOnline: 3, playersMax: 20, playerNames: ["KidExample"] },
        },
        { server: crossplay, state: "offline", checkedAt: new Date("2026-09-14T12:00:25Z"), result: null },
      ],
      now,
    });
    assert.match(html, /<h2>Minecraft<\/h2>/);
    assert.match(html, /<h3>Family Server<\/h3><span class="state ok">(<svg[^>]*>.*?<\/svg>)?Online<\/span>/);
    assert.match(html, /<dt>Players<\/dt><dd>3 \/ 20<\/dd><dt>Version<\/dt><dd>26.2<\/dd>/);
    assert.match(html, /<dt>Join<\/dt><dd>Java family.example:25565<\/dd>/);
    assert.match(html, /<a href="https:\/\/map.example\/">Open the map<\/a>/);
    assert.match(html, /Checked 12 s ago/);
    // Offline: falls back to the configured name, and shows no stale counts.
    assert.match(html, /<h3>Crossplay<\/h3><span class="state bad">/);
    assert.match(html, /Offline<\/span><\/div>\s*<p class="meta">Checked 5 s ago/);
    assert.ok(html.indexOf("<h2>Minecraft</h2>") < html.indexOf("<h2>Release history</h2>"));
    // Names from the ping are for the private admin menu only.
    assert.doesNotMatch(html, /KidExample/);
  });

  test("links each card to the admin menu when it is configured, keeping the map link", () => {
    const minecraft: ServerStatus[] = [{ server: family, state: "offline", checkedAt: null, result: null }];
    const html = renderPage("dev", [], { minecraft, adminUrl: "https://admin.example.com" });
    assert.match(html, /<h3><a class="cover" href="https:\/\/admin.example.com\/servers\/family">Family<\/a><\/h3>/);
    assert.match(html, /<a href="https:\/\/map.example\/">Open the map<\/a>/);
    assert.doesNotMatch(renderPage("dev", [], { minecraft }), /class="cover"/);
  });

  test("escapes values reported by a Minecraft server", () => {
    const html = renderPage("dev", [], {
      minecraft: [
        {
          server: crossplay,
          state: "online",
          checkedAt: null,
          result: { motd: "<img src=x onerror=alert(1)>", version: '"><script>', playersOnline: 0, playersMax: 20, playerNames: [] },
        },
      ],
    });
    assert.match(html, /<h3>&lt;img src=x onerror=alert\(1\)&gt;<\/h3>/);
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /Not checked yet/);
  });
});

describe("renderPage: media", () => {
  const now = new Date("2026-09-15T12:00:30Z");
  const plex: MediaStatus = {
    service: {
      id: "plex",
      name: "Plex",
      kind: "plex",
      checkUrl: "http://plex.example:32400/identity",
      url: "http://tailnet.example:32400/web",
      lanUrl: "http://home.example:32400/web",
    },
    state: "up",
    checkedAt: new Date("2026-09-15T12:00:18Z"),
    result: { version: "1.43.4.10903", setupIncomplete: false },
  };
  const books: MediaStatus = {
    service: { id: "books", name: "Audiobookshelf", kind: "audiobookshelf", checkUrl: "http://books.example/status", url: "http://books.example/", lanUrl: "" },
    state: "up",
    checkedAt: now,
    result: { version: "2.36.0", setupIncomplete: true },
  };
  const sonarr: MediaStatus = {
    service: { id: "sonarr", name: "Sonarr", kind: "arr", checkUrl: "http://sonarr.example:8989/ping", url: "http://sonarr.example:8989", lanUrl: "" },
    state: "down",
    checkedAt: now,
    result: null,
  };

  test("omits the section when nothing is configured", () => {
    assert.doesNotMatch(renderPage("dev", []), /<h2>Media<\/h2>/);
  });

  test("shows state and version, and never an address", () => {
    const html = renderPage("dev", [], { media: [plex, books, sonarr], adminUrl: "https://admin.example.com", now });
    assert.match(html, /<h2>Media<\/h2>/);
    assert.match(html, /<h3><a class="cover" href="https:\/\/admin.example.com\/open\/plex">Plex<\/a><\/h3>/);
    assert.match(html, /<span class="state ok">(<svg[^>]*>.*?<\/svg>)?Up<\/span>/);
    assert.match(html, /<dt>Version<\/dt><dd>1.43.4.10903<\/dd>/);
    assert.match(html, /<span class="state warn">(<svg[^>]*>.*?<\/svg>)?Setup not complete<\/span>/);
    assert.match(html, /<span class="state bad">(<svg[^>]*>.*?<\/svg>)?Down<\/span>/);
    assert.match(html, /Checked 12 s ago/);

    // The point of the section: the public page carries no media address of any kind.
    for (const secret of ["plex.example", "tailnet.example", "home.example", "sonarr.example", "32400", "8989", "books.example", "/identity", "/ping"]) {
      assert.doesNotMatch(html, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `leaked ${secret}`);
    }
  });

  test("without an admin menu, the cards are plain text", () => {
    const html = renderPage("dev", [], { media: [plex], now });
    assert.doesNotMatch(html, /class="cover"/);
    assert.doesNotMatch(html, /32400/);
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
    assert.match(html, /<h2>Remote access<\/h2>/);
    assert.match(html, /<span class="state ok">(<svg[^>]*>.*?<\/svg>)?Connected<\/span>/);
    assert.match(html, /<dt>Relay<\/dt><dd>LHR<\/dd>/);
    // Folded to a count by default, so a phone shows the state first.
    assert.match(html, /<summary>2 devices · 1 online<\/summary>/);
    assert.match(html, /<li><span>laptop-example<\/span><span class="who">macOS · online<\/span><\/li>/);
    assert.match(html, /<li><span>phone-example<\/span><span class="who">iOS · offline, last seen 25 min ago<\/span><\/li>/);
    assert.match(html, /Updated 30 s ago/);
    assert.ok(html.indexOf("<h2>Remote access</h2>") < html.indexOf("<h2>Release history</h2>"));
  });

  test("lists health warnings, escaped", () => {
    const html = renderPage("dev", [], {
      tailscale: { state: "degraded", snapshot: { ...snapshot, health: ["<b>DNS</b> unreachable"] } },
      now,
    });
    assert.match(html, /<span class="state warn">(<svg[^>]*>.*?<\/svg>)?Connected, with warnings<\/span>/);
    assert.match(html, /<dt>Warning<\/dt><dd>&lt;b&gt;DNS&lt;\/b&gt; unreachable<\/dd>/);
    assert.doesNotMatch(html, /<b>/);
  });

  test("names the reason when down, stale or missing", () => {
    const page = (tailscale: TailscaleView) => renderPage("dev", [], { tailscale, now });
    assert.match(
      page({ state: "down", snapshot: { ...snapshot, backendState: "NeedsLogin", online: false } }),
      /<span class="state bad">(<svg[^>]*>.*?<\/svg>)?Needs login<\/span>/,
    );
    assert.match(page({ state: "down", snapshot: { ...snapshot, online: false } }), /Not connected to Tailscale/);
    assert.match(
      page({
        state: "down",
        snapshot: { ...snapshot, backendState: "Unavailable", online: false, error: "tailscale status failed (exit 1)", relay: "", peers: [] },
      }),
      /Not responding<\/span>[\s\S]*<dt>Error<\/dt><dd>tailscale status failed \(exit 1\)<\/dd>/,
    );
    assert.match(
      page({ state: "stale", snapshot: { ...snapshot, generatedAt: new Date("2026-09-14T11:10:00Z") } }),
      /<span class="state warn">(<svg[^>]*>.*?<\/svg>)?No recent update<\/span>[\s\S]*Updated 60 min ago/,
    );
    assert.match(
      page({ state: "missing", snapshot: null }),
      /<span class="state bad">(<svg[^>]*>.*?<\/svg>)?No data<\/span>[\s\S]*Status file missing or unreadable/,
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
    assert.match(html, /<span class="state bad">(<svg[^>]*>.*?<\/svg>)?Offline<\/span>/);
    assert.match(html, /<span class="state bad">(<svg[^>]*>.*?<\/svg>)?No data<\/span>/);
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

describe("admin hostname", () => {
  let pool: Pool;
  let server: Server;
  let port = 0;

  before(async () => {
    pool = createPool("postgres://postgres@127.0.0.1:1/unreachable_test");
    server = createApp(loadConfig({ DATABASE_URL: "postgres://unused/test" }), pool, {
      admin: {
        hostname: "admin.example.com",
        handle: async (_req, res) => {
          res.writeHead(200);
          res.end("admin handler");
        },
      },
    });
    port = await listenOn(server);
  });

  after(async () => {
    server.close();
    await pool.end();
  });

  test("requests for the admin hostname go only to the admin handler", async () => {
    assert.equal((await send(port, "GET", "/servers/family", { headers: { host: "admin.example.com" } })).body, "admin handler");
    assert.equal((await send(port, "GET", "/healthz", { headers: { host: "ADMIN.example.com:443" } })).body, "admin handler");
    const publicReply = await send(port, "GET", "/servers/family", { headers: { host: "status.example.com" } });
    assert.equal(publicReply.status, 404);
    assert.doesNotMatch(publicReply.body, /admin handler/);
  });
});
