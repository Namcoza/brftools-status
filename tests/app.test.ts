import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.ts";
import type { StatusGate, Visitor } from "../src/gate.ts";
import { loadConfig } from "../src/config.ts";
import { createPool, listReleases, migrate, recordRelease, type Pool } from "../src/db.ts";
import type { MediaServiceConfig, MediaStatus } from "../src/media.ts";
import type { MinecraftServerConfig, ServerStatus } from "../src/minecraft.ts";
import { createUserStore } from "../src/users.ts";
import { listenOn, send } from "./http-helper.ts";

const family: MinecraftServerConfig = {
  id: "family",
  name: "Family",
  host: "family.example",
  port: 25565,
  join: "Java family.example:25565",
  mapUrl: "https://map.example/",
};
const offline: ServerStatus[] = [{ server: family, state: "offline", checkedAt: null, result: null }];

const migrationsDir = new URL("../migrations/", import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";

// CI always provides a database. Locally, database tests are skipped with a reason.
const skipDatabase = databaseUrl || process.env.CI ? false : "TEST_DATABASE_URL is not set";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

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
    await pool.query("DROP TABLE IF EXISTS releases, users, schema_migrations");
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
    assert.deepEqual(await migrate(pool, migrationsDir), ["001_create_releases.sql", "002_create_users.sql"]);
    assert.deepEqual(await migrate(pool, migrationsDir), []);
  });

  test("users can be invited once, listed newest first, and removed", async () => {
    const users = createUserStore(pool);
    assert.equal(await users.add("first@example.com"), true);
    assert.equal(await users.add("second@example.com"), true);
    assert.equal(await users.add("first@example.com"), false);
    const listed = await users.list();
    assert.deepEqual(listed.map((user) => user.email).sort(), ["first@example.com", "second@example.com"]);
    assert.equal(listed[0]?.firstSeenAt, null);
    assert.equal(listed[0]?.lastSeenAt, null);
    // A visit records the first and latest sign-in, but only for someone invited.
    assert.equal(await users.visit("first@example.com"), true);
    assert.equal(await users.visit("stranger@example.com"), false);
    const first = (await users.list()).find((user) => user.email === "first@example.com");
    assert.ok(first?.firstSeenAt && first.lastSeenAt);
    // The latest visit is recorded at most every few minutes; the first visit never moves.
    await pool.query("UPDATE users SET first_seen_at = now() - interval '1 day', last_seen_at = now() - interval '1 hour' WHERE email = 'first@example.com'");
    await users.visit("first@example.com");
    const again = (await users.list()).find((user) => user.email === "first@example.com");
    assert.ok(again?.lastSeenAt && Date.now() - again.lastSeenAt.getTime() < 60_000);
    assert.ok(again?.firstSeenAt && Date.now() - again.firstSeenAt.getTime() > 3_600_000);
    const lastSeen = again.lastSeenAt.getTime();
    await users.visit("first@example.com");
    const soon = (await users.list()).find((user) => user.email === "first@example.com");
    assert.equal(soon?.lastSeenAt?.getTime(), lastSeen);
    assert.equal(await users.remove("first@example.com"), true);
    assert.equal(await users.remove("first@example.com"), false);
    assert.deepEqual((await users.list()).map((user) => user.email), ["second@example.com"]);
    // The table only holds lower-case emails; the store is always given normalised ones.
    await assert.rejects(pool.query("INSERT INTO users (email) VALUES ('Upper@Example.com')"), /check constraint/);
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

  test("every tab route renders and reflects live state", async () => {
    for (const path of ["/", "/minecraft", "/media", "/remote", "/releases"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
    }
    const releases = await (await fetch(`${baseUrl}/releases`)).text();
    assert.match(releases, /test-sha/);
    assert.match(releases, /older-sha/);
    const minecraft = await (await fetch(`${baseUrl}/minecraft`)).text();
    assert.match(minecraft, /Offline/);
    const remote = await (await fetch(`${baseUrl}/remote`)).text();
    assert.match(remote, /No data/);
  });

  test("unknown paths return 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
  });

  describe("with sign-in on", () => {
    let gated: Server;
    let port = 0;
    const plex: MediaServiceConfig = {
      id: "plex",
      name: "Plex",
      kind: "plex",
      checkUrl: "http://plex.example/identity",
      url: "http://tailnet.example:32400/web",
      lanUrl: "",
    };
    const media: MediaStatus[] = [{ service: plex, state: "up", checkedAt: new Date(), result: { version: "1.0", setupIncomplete: false } }];
    // Stands in for Access plus the users list; the real ones are tested in gate.test.ts.
    const visitors: Record<string, Visitor> = {
      owner: { kind: "owner", email: "owner@example.com" },
      friend: { kind: "user", email: "friend@example.com" },
      stranger: { kind: "uninvited", email: "stranger@example.com" },
    };
    const gate: StatusGate = {
      async check(req) {
        const token = String(req.headers["cf-access-jwt-assertion"] ?? "");
        return visitors[token] ?? { kind: "anonymous", reason: "no Access token" };
      },
    };
    const as = (token: string, path = "/") => send(port, "GET", path, { headers: { "cf-access-jwt-assertion": token } });

    before(async () => {
      gated = createApp(loadConfig({ DATABASE_URL: databaseUrl, APP_VERSION: "test-sha" }), pool, {
        minecraft: () => offline,
        media: () => media,
        gate,
        admin: { hostname: "admin.example.com", handle: async (_req, res) => void res.end("admin handler") },
      });
      port = await listenOn(gated);
    });

    after(() => {
      gated.close();
    });

    test("every page refuses a request without a valid Access token", async () => {
      for (const path of ["/", "/minecraft", "/media", "/remote", "/releases", "/does-not-exist"]) {
        for (const token of ["", "forged"]) {
          const reply = await as(token, path);
          assert.equal(reply.status, 403, `${path} ${token}`);
          assert.match(reply.body, /Sign in required/);
          assert.doesNotMatch(reply.body, /test-sha|Plex|Family/);
        }
      }
    });

    test("a Google account that is not invited is told so, and sees nothing else", async () => {
      const reply = await as("stranger", "/media");
      assert.equal(reply.status, 403);
      assert.equal(reply.headers["cache-control"], "no-store");
      assert.match(reply.body, /stranger@example.com/);
      assert.match(reply.body, /href="\/cdn-cgi\/access\/logout"/);
      assert.doesNotMatch(reply.body, /test-sha|Plex/);
    });

    test("the owner and invited users see every tab", async () => {
      for (const token of ["owner", "friend"]) {
        for (const path of ["/", "/minecraft", "/media", "/remote", "/releases"]) {
          assert.equal((await as(token, path)).status, 200, `${token} ${path}`);
        }
      }
    });

    test("only the owner gets Open links, which lead to the owner-only admin menu", async () => {
      assert.match((await as("owner", "/media")).body, /https:\/\/admin.example.com\/open\/plex/);
      const friend = await as("friend", "/media");
      assert.match(friend.body, /Plex/);
      assert.doesNotMatch(friend.body, /admin.example.com/);
    });

    test("/healthz stays open for the container health check", async () => {
      assert.equal((await send(port, "GET", "/healthz")).status, 200);
    });

    test("the admin hostname is still handled only by the admin menu", async () => {
      assert.equal((await send(port, "GET", "/", { headers: { host: "admin.example.com" } })).body, "admin handler");
    });
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
