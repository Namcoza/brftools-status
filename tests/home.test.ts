import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HomeFacts } from "../src/config.ts";
import { parseSection, renderHome, type HomeData } from "../src/home.ts";
import type { MediaStatus } from "../src/media.ts";
import type { MinecraftServerConfig, ServerStatus } from "../src/minecraft.ts";
import type { TailscaleSnapshot, TailscaleView } from "../src/tailscale.ts";

const now = new Date("2026-09-24T12:00:30Z");

const family: MinecraftServerConfig = {
  id: "family",
  name: "Family Java Server",
  host: "family.example",
  port: 25565,
  join: "Java family.example:25565",
  mapUrl: "https://map.example/",
};

const emptyFacts: HomeFacts = { drive: null, hardware: [], issues: [], reach: [] };

function base(overrides: Partial<HomeData> = {}): HomeData {
  return {
    section: "overview",
    currentVersion: "dev",
    minecraft: [],
    media: [],
    tailscale: null,
    releases: [],
    facts: emptyFacts,
    adminUrl: "",
    nav: { statusUrl: "/", gamesUrl: "", mapUrl: "" },
    now,
    mediaFilter: "all",
    mediaView: "cards",
    ...overrides,
  };
}

describe("parseSection", () => {
  test("maps known paths and rejects everything else", () => {
    assert.equal(parseSection("/"), "overview");
    assert.equal(parseSection("/media"), "media");
    assert.equal(parseSection("/nope"), null);
  });
});

describe("renderHome: overview", () => {
  test("reports all systems up when every source is up", () => {
    const minecraft: ServerStatus[] = [
      { server: family, state: "online", checkedAt: now, result: { motd: "", version: "26.2", playersOnline: 2, playersMax: 20, playerNames: [] } },
    ];
    const media: MediaStatus[] = [
      { service: { id: "plex", name: "Plex", kind: "plex", checkUrl: "x", url: "x", lanUrl: "" }, state: "up", checkedAt: now, result: { version: "1.43", setupIncomplete: false } },
    ];
    const html = renderHome(base({ minecraft, media }));
    assert.match(html, /All systems up/);
    assert.match(html, /class="state ok"/);
    assert.match(html, /2<span class="of"> \/ 20<\/span>/);
  });

  test("counts services down and names the count", () => {
    const minecraft: ServerStatus[] = [{ server: family, state: "offline", checkedAt: now, result: null }];
    const html = renderHome(base({ minecraft }));
    assert.match(html, /1 service down/);
    assert.match(html, /class="state bad"/);
  });

  test("the media mini-list on the overview card shows no address or port", () => {
    const media: MediaStatus[] = [
      { service: { id: "plex", name: "Plex", kind: "plex", checkUrl: "http://plex.example:32400/identity", url: "http://tailnet.example:32400/web", lanUrl: "http://home.example:32400/web" }, state: "up", checkedAt: now, result: { version: "1.43.4", setupIncomplete: false } },
    ];
    const html = renderHome(base({ media }));
    for (const secret of ["plex.example", "tailnet.example", "home.example", "32400", "/identity"]) {
      assert.doesNotMatch(html, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `leaked ${secret}`);
    }
    assert.match(html, /1\.43\.4/);
  });

  test("hardware and issues are hidden unless HOME_FACTS_JSON configures them", () => {
    assert.doesNotMatch(renderHome(base()), /Needs attention|Hardware/);
    const facts: HomeFacts = {
      drive: { usedTb: 6.1, totalTb: 8 },
      hardware: [{ label: "GPU", value: "Quadro K2200", detail: "" }],
      issues: [{ tag: "fix", title: "Network is slow", body: "Runs at 100 Mb/s." }],
      reach: [],
    };
    const html = renderHome(base({ facts }));
    assert.match(html, /Needs attention/);
    assert.match(html, /Hardware/);
    assert.match(html, /Quadro K2200/);
    assert.match(html, /Network is slow/);
    assert.match(html, /6\.1<span class="of"> \/ 8 TB<\/span>/);
  });
});

describe("renderHome: minecraft", () => {
  test("shows state, players, version, join and the map link", () => {
    const minecraft: ServerStatus[] = [
      { server: family, state: "online", checkedAt: now, result: { motd: "", version: "26.2", playersOnline: 3, playersMax: 20, playerNames: ["KidExample"] } },
    ];
    const html = renderHome(base({ section: "minecraft", minecraft }));
    assert.match(html, /Online/);
    assert.match(html, /3<span class="of"> \/ 20<\/span>/);
    assert.match(html, /26\.2/);
    assert.match(html, /Java family\.example:25565/);
    assert.match(html, /href="https:\/\/map\.example\/"/);
    // Player names are for the admin menu only.
    assert.doesNotMatch(html, /KidExample/);
  });

  test("names the case with no servers configured", () => {
    assert.match(renderHome(base({ section: "minecraft" })), /No servers configured/);
  });
});

describe("renderHome: media", () => {
  const plex: MediaStatus = {
    service: { id: "plex", name: "Plex", kind: "plex", checkUrl: "http://plex.example:32400/identity", url: "http://tailnet.example:32400/web", lanUrl: "http://home.example:32400/web" },
    state: "up",
    checkedAt: now,
    result: { version: "1.43.4", setupIncomplete: false },
  };
  const sonarr: MediaStatus = {
    service: { id: "sonarr", name: "Sonarr", kind: "arr", checkUrl: "http://sonarr.example:8989/ping", url: "http://sonarr.example:8989", lanUrl: "" },
    state: "down",
    checkedAt: now,
    result: null,
  };

  test("cards view: an Open link only appears with an admin URL, and goes through /open/<id>", () => {
    const withAdmin = renderHome(base({ section: "media", media: [plex, sonarr], adminUrl: "https://admin.example.com" }));
    assert.match(withAdmin, /href="https:\/\/admin\.example\.com\/open\/plex"/);
    const withoutAdmin = renderHome(base({ section: "media", media: [plex] }));
    assert.doesNotMatch(withoutAdmin, />Open ↗</);
  });

  test("cards and table views never leak an address or port", () => {
    for (const mediaView of ["cards", "table"] as const) {
      const html = renderHome(base({ section: "media", media: [plex, sonarr], adminUrl: "https://admin.example.com", mediaView }));
      // Scan the body only: the stylesheet's colour tokens can coincidentally contain digit runs (e.g. #98989b).
      const body = html.slice(html.indexOf("</style>"));
      for (const secret of ["plex.example", "tailnet.example", "home.example", "sonarr.example", "32400", "8989", "/identity", "/ping"]) {
        assert.doesNotMatch(body, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `leaked ${secret} in ${mediaView} view`);
      }
    }
  });

  test("the group filter narrows the shown services and marks the active one", () => {
    const html = renderHome(base({ section: "media", media: [plex, sonarr], mediaFilter: "play" }));
    assert.match(html, /Plex/);
    assert.doesNotMatch(html, /Sonarr/);
    assert.match(html, /<a href="\/media\?group=play" class="active">/);
  });

  test("names the case with no media configured", () => {
    assert.match(renderHome(base({ section: "media" })), /No media services configured/);
  });
});

describe("renderHome: remote access", () => {
  const snapshot: TailscaleSnapshot = {
    generatedAt: new Date("2026-09-24T11:59:30Z"),
    backendState: "Running",
    error: "",
    online: true,
    health: [],
    relay: "lhr",
    peers: [
      { name: "laptop", os: "macOS", online: true, lastSeen: null },
      { name: "phone", os: "iOS", online: false, lastSeen: null },
    ],
  };

  test("shows connection state, relay and device counts", () => {
    const tailscale: TailscaleView = { state: "connected", snapshot };
    const html = renderHome(base({ section: "remote", tailscale }));
    assert.match(html, /Connected/);
    assert.match(html, /LHR/);
    assert.match(html, /1<span class="of"> of 2 online<\/span>/);
  });

  test("the reach table is hidden unless HOME_FACTS_JSON configures it", () => {
    const tailscale: TailscaleView = { state: "connected", snapshot };
    assert.doesNotMatch(renderHome(base({ section: "remote", tailscale })), /Who can reach what/);
    const facts: HomeFacts = { drive: null, hardware: [], issues: [], reach: [{ name: "Plex", home: "Yes", tail: "Yes", any: "Yes", anyOk: true, note: "" }] };
    assert.match(renderHome(base({ section: "remote", tailscale, facts })), /Who can reach what/);
  });

  test("names the case with no Tailscale source configured", () => {
    assert.match(renderHome(base({ section: "remote" })), /Not configured/);
  });
});

describe("renderHome: releases", () => {
  test("lists releases and marks the running version", () => {
    const html = renderHome(
      base({
        section: "releases",
        currentVersion: "abc123",
        releases: [
          { version: "abc123", startedAt: new Date("2026-09-24T10:00:00Z") },
          { version: "older", startedAt: new Date("2026-09-23T10:00:00Z") },
        ],
      }),
    );
    assert.match(html, /Running now/);
    assert.match(html, /abc123/);
    assert.match(html, /older/);
  });

  test("shows an empty state", () => {
    assert.match(renderHome(base({ section: "releases" })), /No releases recorded yet/);
  });
});
