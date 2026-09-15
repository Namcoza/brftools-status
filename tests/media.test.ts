import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, test } from "node:test";
import {
  checkService,
  createMediaMonitor,
  parseArr,
  parseAudiobookshelf,
  parsePlex,
  parseSabnzbd,
  type MediaServiceConfig,
} from "../src/media.ts";
import { listenOn } from "./http-helper.ts";

// Real responses, captured from the services on 15 September 2026.
const PLEX_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" apiVersion="1.2.3" claimed="1" machineIdentifier="b93ca2a4d0b59095ad10d834e7dde91d9e72c129" version="1.43.4.10903-e5521bd8c">\n</MediaContainer>\n';
const ARR_JSON = '{\n  "status": "OK"\n}';
const SAB_JSON = '{"version":"5.1.3"}';
const ABS_JSON =
  '{"app":"audiobookshelf","serverVersion":"2.36.0","isInit":false,"language":"en-us","authMethods":["local"],"authFormData":{"authLoginCustomMessage":""},"ConfigPath":"/config","MetadataPath":"/metadata"}';

function service(kind: MediaServiceConfig["kind"], checkUrl: string): MediaServiceConfig {
  return { id: kind, name: kind, kind, checkUrl, url: "http://service.example/", lanUrl: "" };
}

describe("parsers", () => {
  test("Plex: version without the build hash", () => {
    assert.deepEqual(parsePlex(PLEX_XML), { version: "1.43.4.10903", setupIncomplete: false });
    assert.deepEqual(parsePlex("<MediaContainer/>"), { version: "", setupIncomplete: false });
  });

  test("Sonarr and Radarr: up only when the ping says OK", () => {
    assert.deepEqual(parseArr(ARR_JSON), { version: "", setupIncomplete: false });
    assert.throws(() => parseArr('{"status":"NOT OK"}'), /did not report OK/);
    assert.throws(() => parseArr("not json"));
  });

  test("SABnzbd: version", () => {
    assert.deepEqual(parseSabnzbd(SAB_JSON), { version: "5.1.3", setupIncomplete: false });
    assert.deepEqual(parseSabnzbd("{}"), { version: "", setupIncomplete: false });
  });

  test("Audiobookshelf: version and setup state, with its internal paths discarded", () => {
    const result = parseAudiobookshelf(ABS_JSON);
    assert.deepEqual(result, { version: "2.36.0", setupIncomplete: true });
    assert.doesNotMatch(JSON.stringify(result), /ConfigPath|MetadataPath|\/config|\/metadata/);
    assert.equal(parseAudiobookshelf('{"serverVersion":"2.36.0","isInit":true}').setupIncomplete, false);
  });
});

describe("checkService", () => {
  const servers: Server[] = [];

  function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    return listenOn(server).then((port) => `http://127.0.0.1:${port}`);
  }

  after(() => {
    for (const server of servers) server.close();
  });

  test("reads a service that answers", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(SAB_JSON);
    });
    assert.deepEqual(await checkService(service("sabnzbd", `${base}/api`), 2000), { version: "5.1.3", setupIncomplete: false });
  });

  test("rejects a non-200, a hang and a connection failure", async () => {
    const error = await serve((_req, res) => {
      res.writeHead(503);
      res.end("nope");
    });
    await assert.rejects(checkService(service("arr", `${error}/ping`), 2000), /status 503/);

    const hang = await serve(() => {
      /* never answers */
    });
    await assert.rejects(checkService(service("arr", `${hang}/ping`), 200));

    const closed = createServer();
    const port = await listenOn(closed);
    await new Promise((resolve) => closed.close(resolve));
    await assert.rejects(checkService(service("arr", `http://127.0.0.1:${port}/ping`), 2000));
  });

  test("survives an absurdly large body", async () => {
    const big = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(PLEX_XML + "x".repeat(500_000));
    });
    assert.equal((await checkService(service("plex", `${big}/identity`), 3000)).version, "1.43.4.10903");
  });
});

describe("createMediaMonitor", () => {
  const services: MediaServiceConfig[] = [
    { id: "up-one", name: "Up one", kind: "sabnzbd", checkUrl: "http://up.example/", url: "http://up.example/", lanUrl: "" },
    { id: "down-one", name: "Down one", kind: "arr", checkUrl: "http://down.example/", url: "http://down.example/", lanUrl: "" },
  ];
  const checkedAt = new Date("2026-09-15T12:00:00Z");

  test("starts unknown, then records each service independently", async () => {
    const monitor = createMediaMonitor(services, {
      now: () => checkedAt,
      check: async (target) => {
        if (target.id === "down-one") throw new Error("connection refused");
        return { version: "5.1.3", setupIncomplete: false };
      },
    });
    assert.deepEqual(
      monitor.statuses().map((status) => status.state),
      ["unknown", "unknown"],
    );

    await monitor.refresh();
    const [up, down] = monitor.statuses();
    assert.deepEqual(up, { service: services[0], state: "up", checkedAt, result: { version: "5.1.3", setupIncomplete: false } });
    assert.deepEqual(down, { service: services[1], state: "down", checkedAt, result: null });
  });

  test("does nothing when no services are configured", () => {
    const monitor = createMediaMonitor([], {
      check: () => {
        throw new Error("must not check");
      },
    });
    monitor.start();
    monitor.stop();
    assert.deepEqual(monitor.statuses(), []);
  });
});
