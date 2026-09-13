import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, renderPage } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createPool, listReleases, migrate, recordRelease, type Pool } from "../src/db.ts";

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
    server = createApp(loadConfig({ DATABASE_URL: databaseUrl, APP_VERSION: "test-sha" }), pool);
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

  test("GET /healthz reports ok, the version and the database", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", version: "test-sha", database: "ok" });
  });

  test("GET / lists the release history", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /test-sha/);
    assert.match(html, /older-sha/);
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
