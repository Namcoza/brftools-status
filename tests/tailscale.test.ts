import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { classify, parseSnapshot, readTailscale, STALE_AFTER_MS } from "../src/tailscale.ts";

const now = new Date("2026-09-14T12:00:00Z");

// The format written by the host's tailscale-snapshot timer.
const sample = {
  version: 1,
  generatedAt: "2026-09-14T11:59:30Z",
  backendState: "Running",
  online: true,
  health: [],
  relay: "lhr",
  peers: [
    { name: "laptop-example", os: "macOS", online: true, lastSeen: null },
    { name: "phone-example", os: "iOS", online: false, lastSeen: "2026-09-14T10:00:00Z" },
  ],
};

describe("parseSnapshot", () => {
  test("reads the host timer's format", () => {
    assert.deepEqual(parseSnapshot(JSON.stringify(sample)), {
      generatedAt: new Date("2026-09-14T11:59:30Z"),
      backendState: "Running",
      error: "",
      online: true,
      health: [],
      relay: "lhr",
      peers: [
        { name: "laptop-example", os: "macOS", online: true, lastSeen: null },
        { name: "phone-example", os: "iOS", online: false, lastSeen: new Date("2026-09-14T10:00:00Z") },
      ],
    });
  });

  test("ignores malformed fields", () => {
    const snapshot = parseSnapshot(
      JSON.stringify({
        generatedAt: sample.generatedAt,
        online: "yes",
        health: ["a warning", 3, null],
        peers: [{ name: 7, lastSeen: "not a date" }],
      }),
    );
    assert.equal(snapshot.online, false);
    assert.deepEqual(snapshot.health, ["a warning"]);
    assert.deepEqual(snapshot.peers, [{ name: "", os: "", online: false, lastSeen: null }]);
  });

  test("rejects a snapshot without a valid time, or that is not JSON", () => {
    assert.throws(() => parseSnapshot("{}"), /generatedAt/);
    assert.throws(() => parseSnapshot("null"), /generatedAt/);
    assert.throws(() => parseSnapshot("not json"));
  });
});

describe("classify", () => {
  const snapshot = parseSnapshot(JSON.stringify(sample));
  const justInTime = new Date(snapshot.generatedAt.getTime() + STALE_AFTER_MS);
  const tooLate = new Date(justInTime.getTime() + 1);

  test("connected, degraded or down from a fresh snapshot", () => {
    assert.equal(classify(snapshot, now), "connected");
    assert.equal(classify({ ...snapshot, health: ["a warning"] }, now), "degraded");
    assert.equal(classify({ ...snapshot, backendState: "NeedsLogin" }, now), "down");
    assert.equal(classify({ ...snapshot, online: false }, now), "down");
  });

  test("stale once the snapshot is too old, whatever it says", () => {
    assert.equal(classify(snapshot, justInTime), "connected");
    assert.equal(classify(snapshot, tooLate), "stale");
    assert.equal(classify({ ...snapshot, backendState: "Stopped" }, tooLate), "stale");
  });
});

describe("readTailscale", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "tailscale-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads and classifies the file", async () => {
    const path = join(dir, "status.json");
    await writeFile(path, JSON.stringify(sample));
    const view = await readTailscale(path, now);
    assert.equal(view.state, "connected");
    assert.equal(view.snapshot?.peers.length, 2);
  });

  test("a missing or unreadable file is reported as missing", async () => {
    assert.deepEqual(await readTailscale(join(dir, "absent.json"), now), { state: "missing", snapshot: null });
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{");
    assert.deepEqual(await readTailscale(broken, now), { state: "missing", snapshot: null });
  });
});
