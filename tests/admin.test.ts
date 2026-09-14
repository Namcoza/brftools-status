import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { AccessError, type AccessVerifier } from "../src/access.ts";
import { createAdminHandler } from "../src/admin.ts";
import type { MinecraftServerConfig, ServerStatus } from "../src/minecraft.ts";
import { listenOn, send } from "./http-helper.ts";

const hostname = "admin.example.com";
const family: MinecraftServerConfig = { id: "family", name: "Family", host: "family.example", port: 25565, join: "", mapUrl: "" };
const crossplay: MinecraftServerConfig = { id: "crossplay", name: "Crossplay", host: "crossplay.example", port: 25565, join: "", mapUrl: "" };

// Stands in for Cloudflare Access; the real verification is tested in access.test.ts.
const verifier: AccessVerifier = {
  async verify(token) {
    if (token === "valid-token") return { email: "owner@example.com" };
    throw new AccessError(token ? "bad token signature" : "no Access token");
  },
};
const signedIn = { "cf-access-jwt-assertion": "valid-token" };
const sameOrigin = { ...signedIn, "sec-fetch-site": "same-origin" };

let dir = "";
let inbox = "";
let state = "";
let server: Server;
let port = 0;
let statuses: ServerStatus[] = [];

async function writeSnapshot(id: string, fields: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(state, "servers", `${id}.json`),
    JSON.stringify({
      id,
      generatedAt: new Date().toISOString(),
      exists: true,
      running: true,
      status: "running",
      health: "healthy",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      stopped: null,
      log: [],
      ...fields,
    }),
  );
}

const queued = () => readdir(join(inbox, "new"));
const post = (path: string, body: string, headers: Record<string, string> = sameOrigin) => send(port, "POST", path, { headers, body });
const get = (path: string) => send(port, "GET", path, { headers: signedIn });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "admin-test-"));
  inbox = join(dir, "inbox");
  state = join(dir, "state");
  const handle = createAdminHandler({
    hostname,
    verifier,
    servers: [family, crossplay],
    minecraft: () => statuses,
    inboxDir: inbox,
    stateDir: state,
  });
  server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  port = await listenOn(server);
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(inbox, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  for (const path of [join(inbox, "new"), join(inbox, "tmp"), join(state, "servers"), join(state, "results")]) {
    await mkdir(path, { recursive: true });
  }
  statuses = [
    {
      server: family,
      state: "online",
      checkedAt: new Date(),
      result: { motd: "Family", version: "26.2", playersOnline: 2, playersMax: 20, playerNames: ["KidOne", "KidTwo"] },
    },
    {
      server: crossplay,
      state: "online",
      checkedAt: new Date(),
      result: { motd: "Crossplay", version: "Paper 26.2", playersOnline: 0, playersMax: 20, playerNames: [] },
    },
  ];
  await writeSnapshot("family", { log: ["[10:00:00] <KidOne> <script>alert(1)</script>", "[10:00:01] KidOne[/<ip>:5000] logged in"] });
  await writeSnapshot("crossplay");
});

describe("admin menu access", () => {
  test("refuses every route without a valid Access token", async () => {
    const routes = [
      ["GET", "/"],
      ["GET", "/servers/family"],
      ["GET", "/servers/family/confirm?action=restart"],
      ["POST", "/servers/family/actions"],
      ["GET", `/actions/${"a".repeat(32)}`],
      ["GET", "/no-such-page"],
    ] as const;
    const tokens: Record<string, string>[] = [{}, { "cf-access-jwt-assertion": "forged-token" }];
    for (const [method, path] of routes) {
      for (const token of tokens) {
        const reply = await send(port, method, path, {
          headers: { ...token, "sec-fetch-site": "same-origin" },
          body: method === "POST" ? "action=restart" : undefined,
        });
        assert.equal(reply.status, 403, `${method} ${path}`);
        assert.doesNotMatch(reply.body, /Family|KidOne/);
      }
    }
    assert.deepEqual(await queued(), []);
  });

  test("refuses form posts that did not come from the admin menu", async () => {
    for (const headers of [
      { ...signedIn, "sec-fetch-site": "cross-site" },
      { ...signedIn, "sec-fetch-site": "same-site" },
      { ...signedIn, origin: "https://evil.example" },
      signedIn,
    ]) {
      assert.equal((await post("/servers/family/actions", "action=save", headers)).status, 403);
    }
    assert.deepEqual(await queued(), []);
  });

  test("accepts a matching Origin when the browser sends no Sec-Fetch-Site", async () => {
    const reply = await post("/servers/family/actions", "action=save", { ...signedIn, origin: `https://${hostname}` });
    assert.equal(reply.status, 303);
  });

  test("admin pages are not cached, framed or scripted", async () => {
    const reply = await get("/servers/family");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.match(String(reply.headers["content-security-policy"]), /default-src 'none'.*frame-ancestors 'none'/);
  });
});

describe("admin menu pages", () => {
  test("the overview shows each server's state and who is online, by name", async () => {
    const { status, body } = await get("/");
    assert.equal(status, 200);
    assert.match(body, /<a class="card-link" href="\/servers\/family">Family<\/a>/);
    assert.match(body, /<span class="state online">Running<\/span>/);
    assert.match(body, /2 \/ 20 — KidOne, KidTwo/);
    assert.match(body, /Signed in as owner@example.com/);
  });

  test("a running server offers save, restart and stop, and shows its log escaped", async () => {
    const { body } = await get("/servers/family");
    assert.match(body, /<input type="hidden" name="action" value="save" \/><button type="submit">Save world<\/button>/);
    assert.match(body, /href="\/servers\/family\/confirm\?action=restart"/);
    assert.match(body, /href="\/servers\/family\/confirm\?action=stop"/);
    assert.doesNotMatch(body, /value="start"/);
    assert.match(body, /Version<\/dt><dd>26.2/);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(body, /<script>/);
  });

  test("a stopped server offers only start, and says who stopped it", async () => {
    await writeSnapshot("family", {
      running: false,
      status: "exited",
      health: null,
      stopped: { stoppedBy: "owner@example.com", stoppedAt: new Date().toISOString() },
    });
    const { body } = await get("/servers/family");
    assert.match(body, /<span class="state offline">Stopped<\/span>/);
    assert.match(body, /Stopped by<\/dt><dd>owner@example.com, \d+ s ago/);
    assert.match(body, /value="start"/);
    assert.doesNotMatch(body, /value="save"|action=restart|action=stop/);
  });

  test("without state from the host, no actions are offered", async () => {
    await rm(join(state, "servers", "family.json"));
    const { body } = await get("/servers/family");
    assert.match(body, /No data from the host/);
    assert.match(body, /Actions are unavailable/);
    assert.doesNotMatch(body, /<form/);
  });

  test("confirming a restart names the players who will be warned", async () => {
    const { body } = await get("/servers/family/confirm?action=restart");
    assert.match(body, /<strong>2 players are online<\/strong> \(KidOne, KidTwo\)/);
    assert.match(body, /warned in chat at 60, 30 and 10 seconds/);
    assert.match(body, /value="restart" \/><button type="submit" class="danger">Restart now<\/button>/);
  });

  test("confirming a stop says it stays stopped", async () => {
    const { body } = await get("/servers/crossplay/confirm?action=stop");
    assert.match(body, /Nobody is online, so this happens straight away/);
    assert.match(body, /stays stopped, even if the host reboots, until someone presses Start/);
  });

  test("recent actions come from the runner's history, newest first", async () => {
    const lines = [
      { id: "1".repeat(32), server: "family", action: "save", requestedBy: "owner@example.com", status: "done", step: "saved", finishedAt: new Date(Date.now() - 600_000).toISOString() },
      { id: "2".repeat(32), server: "crossplay", action: "stop", requestedBy: "owner@example.com", status: "done", step: "stopped", finishedAt: new Date().toISOString() },
      { id: "3".repeat(32), server: "family", action: "restart", requestedBy: "owner@example.com", status: "failed", step: "waiting for healthy", finishedAt: new Date().toISOString() },
    ];
    await writeFile(join(state, "history.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`);
    const { body } = await get("/servers/family");
    assert.ok(body.indexOf("Failed (waiting for healthy)") < body.indexOf("Done (saved)"));
    assert.doesNotMatch(body, /Done \(stopped\)/);
  });
});

describe("admin menu actions", () => {
  test("a post queues a request for the host runner and redirects to its progress", async () => {
    const reply = await post("/servers/family/actions", "action=restart");
    assert.equal(reply.status, 303);

    const [file, ...others] = await queued();
    assert.ok(file);
    assert.deepEqual(others, []);
    const { id, requestedAt, ...request } = JSON.parse(await readFile(join(inbox, "new", file), "utf8"));
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(file, `${id}.json`);
    assert.ok(!Number.isNaN(Date.parse(requestedAt)));
    assert.deepEqual(request, { server: "family", action: "restart", requestedBy: "owner@example.com" });
    assert.equal(reply.headers.location, `/actions/${id}`);
    assert.deepEqual(await readdir(join(inbox, "tmp")), []);

    const progress = await get(`/actions/${id}`);
    assert.match(progress.body, /<span class="state warning">Queued<\/span>/);
    assert.match(progress.body, /http-equiv="refresh" content="3"/);
  });

  test("refuses actions that don't fit the server's state, are unknown, or would overlap", async () => {
    assert.equal((await post("/servers/family/actions", "action=start")).status, 409);
    assert.equal((await post("/servers/family/actions", "action=op")).status, 400);
    assert.equal((await post("/servers/family/actions", `action=save&pad=${"x".repeat(2000)}`)).status, 413);
    assert.equal((await post("/servers/survival/actions", "action=save")).status, 404);
    assert.deepEqual(await queued(), []);

    assert.equal((await post("/servers/family/actions", "action=save")).status, 303);
    const overlap = await post("/servers/crossplay/actions", "action=save");
    assert.equal(overlap.status, 409);
    assert.match(overlap.body, /Another action is in progress/);
    assert.equal((await queued()).length, 1);
  });

  test("a running result blocks new actions and shows progress until it finishes", async () => {
    const id = "b".repeat(32);
    const result = { id, server: "crossplay", action: "restart", requestedBy: "owner@example.com", step: "waiting for healthy", detail: "40s so far; health: starting" };
    const resultFile = join(state, "results", `${id}.json`);
    await writeFile(resultFile, JSON.stringify({ ...result, status: "running", updatedAt: new Date().toISOString() }));

    assert.equal((await post("/servers/family/actions", "action=save")).status, 409);
    assert.match((await get("/servers/family")).body, new RegExp(`Another action is in progress: <a href="/actions/${id}">`));
    const running = await get(`/actions/${id}`);
    assert.match(running.body, /<h1>Restart: Crossplay<\/h1>/);
    assert.match(running.body, /<span class="state warning">In progress<\/span>/);
    assert.match(running.body, /Step<\/dt><dd>Waiting for healthy/);

    await writeFile(resultFile, JSON.stringify({ ...result, status: "done", step: "healthy", detail: "", updatedAt: new Date().toISOString() }));
    const done = await get(`/actions/${id}`);
    assert.match(done.body, /<span class="state online">Done<\/span>/);
    assert.doesNotMatch(done.body, /http-equiv="refresh"/);
    assert.equal((await post("/servers/family/actions", "action=save")).status, 303);
  });

  test("a failed action shows the log the runner captured, escaped", async () => {
    const id = "c".repeat(32);
    await writeFile(
      join(state, "results", `${id}.json`),
      JSON.stringify({ id, server: "family", action: "start", status: "failed", step: "waiting for healthy", detail: "<b>crash</b>", updatedAt: new Date().toISOString() }),
    );
    const { body } = await get(`/actions/${id}`);
    assert.match(body, /<span class="state offline">Failed<\/span>/);
    assert.match(body, /<pre class="log">&lt;b&gt;crash&lt;\/b&gt;<\/pre>/);
  });

  test("unknown routes are not found", async () => {
    for (const path of ["/servers/survival", "/actions/not-an-id", "/servers/family/confirm?action=op", "/healthz", "/servers/family/logs"]) {
      assert.equal((await get(path)).status, 404, path);
    }
  });
});
