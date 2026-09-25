import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createPool, listReleases, migrate, recordRelease, type Pool } from "../src/db.ts";
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
