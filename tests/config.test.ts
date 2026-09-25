import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const required = { DATABASE_URL: "postgres://localhost/example" };

test("defaults apply when optional variables are unset", () => {
  const config = loadConfig(required);
  assert.equal(config.port, 3000);
  assert.equal(config.appVersion, "dev");
});

test("empty values count as unset", () => {
  const config = loadConfig({ ...required, PORT: "", APP_VERSION: "" });
  assert.equal(config.port, 3000);
  assert.equal(config.appVersion, "dev");
});

test("an invalid PORT fails at startup", () => {
  assert.throws(() => loadConfig({ ...required, PORT: "not-a-port" }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ ...required, PORT: "70000" }), /PORT must be an integer/);
});

test("no Minecraft servers are configured by default", () => {
  assert.deepEqual(loadConfig(required).minecraftServers, []);
  assert.deepEqual(loadConfig({ ...required, MC_1_NAME: "", MC_1_PING: "" }).minecraftServers, []);
});

test("Minecraft servers are read from numbered variables, skipping gaps", () => {
  const config = loadConfig({
    ...required,
    MC_1_NAME: "Crossplay",
    MC_1_PING: "crossplay.example:25565",
    MC_3_ID: "family",
    MC_3_NAME: "Family",
    MC_3_PING: "family.example:25566",
    MC_3_JOIN: "Java family.example:25566",
    MC_3_MAP_URL: "https://map.example/",
  });
  assert.deepEqual(config.minecraftServers, [
    { id: "", name: "Crossplay", host: "crossplay.example", port: 25565, join: "", mapUrl: "" },
    {
      id: "family",
      name: "Family",
      host: "family.example",
      port: 25566,
      join: "Java family.example:25566",
      mapUrl: "https://map.example/",
    },
  ]);
});

test("invalid Minecraft configuration fails at startup", () => {
  assert.throws(() => loadConfig({ ...required, MC_1_PING: "mc.example:25565" }), /MC_1_NAME must be set/);
  assert.throws(() => loadConfig({ ...required, MC_2_NAME: "Orphan" }), /MC_2_PING must be set/);
  assert.throws(() => loadConfig({ ...required, MC_2_ID: "orphan" }), /MC_2_PING must be set/);
  for (const ping of ["mc.example", "mc.example:0", "mc.example:70000", ":25565", "mc example:25565"]) {
    assert.throws(() => loadConfig({ ...required, MC_1_NAME: "A", MC_1_PING: ping }), /MC_1_PING must be host:port/);
  }
  assert.throws(
    () => loadConfig({ ...required, MC_1_NAME: "A", MC_1_PING: "mc.example:25565", MC_1_MAP_URL: "javascript:alert(1)" }),
    /MC_1_MAP_URL must be an http or https URL/,
  );
  for (const id of ["Family", "family server", "../etc", "x".repeat(33)]) {
    assert.throws(() => loadConfig({ ...required, MC_1_NAME: "A", MC_1_PING: "mc.example:25565", MC_1_ID: id }), /MC_1_ID must be/);
  }
  assert.throws(
    () =>
      loadConfig({
        ...required,
        MC_1_NAME: "A",
        MC_1_PING: "a.example:25565",
        MC_1_ID: "same",
        MC_2_NAME: "B",
        MC_2_PING: "b.example:25565",
        MC_2_ID: "same",
      }),
    /MC_2_ID "same" is already used/,
  );
});

const media = {
  MEDIA_1_ID: "plex",
  MEDIA_1_NAME: "Plex",
  MEDIA_1_KIND: "plex",
  MEDIA_1_CHECK: "http://plex.example:32400/identity",
  MEDIA_1_URL: "http://tailnet.example:32400/web",
  MEDIA_1_LAN_URL: "http://lan.example:32400/web",
};

test("media services are optional, and read from numbered variables", () => {
  assert.deepEqual(loadConfig(required).mediaServices, []);
  assert.deepEqual(loadConfig({ ...required, ...media }).mediaServices, [
    {
      id: "plex",
      name: "Plex",
      kind: "plex",
      checkUrl: "http://plex.example:32400/identity",
      url: "http://tailnet.example:32400/web",
      lanUrl: "http://lan.example:32400/web",
    },
  ]);
});

test("media services are read up to the limit, and higher numbers are ignored", () => {
  const last = {
    MEDIA_12_ID: "navidrome",
    MEDIA_12_NAME: "Navidrome",
    MEDIA_12_KIND: "http",
    MEDIA_12_CHECK: "http://navidrome.example:4533/",
    MEDIA_12_URL: "http://tailnet.example:4533/",
  };
  const beyondLimit = {
    MEDIA_13_ID: "beyond",
    MEDIA_13_NAME: "Beyond",
    MEDIA_13_KIND: "http",
    MEDIA_13_CHECK: "http://beyond.example/",
    MEDIA_13_URL: "http://beyond.example/",
  };
  const services = loadConfig({ ...required, ...media, ...last, ...beyondLimit }).mediaServices;
  assert.deepEqual(services.map((service) => service.id), ["plex", "navidrome"]);
});

test("invalid media configuration fails at startup", () => {
  assert.throws(() => loadConfig({ ...required, MEDIA_1_NAME: "Plex" }), /MEDIA_1_CHECK must be set when other/);
  for (const missing of ["MEDIA_1_ID", "MEDIA_1_NAME", "MEDIA_1_KIND", "MEDIA_1_URL"]) {
    const partial: Record<string, string> = { ...required, ...media };
    delete partial[missing];
    assert.throws(() => loadConfig(partial), new RegExp(`${missing} must be set`));
  }
  assert.throws(() => loadConfig({ ...required, ...media, MEDIA_1_KIND: "docker" }), /MEDIA_1_KIND must be one of/);
  assert.throws(() => loadConfig({ ...required, ...media, MEDIA_1_ID: "Plex Server" }), /MEDIA_1_ID must be/);
  assert.throws(() => loadConfig({ ...required, ...media, MEDIA_1_URL: "javascript:alert(1)" }), /MEDIA_1_URL must be an http/);
  assert.throws(() => loadConfig({ ...required, ...media, MEDIA_1_CHECK: "file:///etc/passwd" }), /MEDIA_1_CHECK must be an http/);
  assert.throws(
    () => loadConfig({ ...required, ...media, MEDIA_2_ID: "plex", MEDIA_2_NAME: "Other", MEDIA_2_KIND: "arr", MEDIA_2_CHECK: "http://a.example/ping", MEDIA_2_URL: "http://a.example/" }),
    /MEDIA_2_ID "plex" is already used/,
  );
});

test("TAILSCALE_STATUS_FILE is optional and must be an absolute path", () => {
  assert.equal(loadConfig(required).tailscaleStatusFile, "");
  assert.equal(
    loadConfig({ ...required, TAILSCALE_STATUS_FILE: "/run/example/status.json" }).tailscaleStatusFile,
    "/run/example/status.json",
  );
  assert.throws(() => loadConfig({ ...required, TAILSCALE_STATUS_FILE: "status.json" }), /must be an absolute path/);
});

const withServer = { ...required, MC_1_ID: "family", MC_1_NAME: "Family", MC_1_PING: "family.example:25565" };
const admin = {
  ADMIN_HOSTNAME: "admin.example.com",
  ACCESS_TEAM_DOMAIN: "team.example.com",
  ACCESS_AUD: "a".repeat(64),
  MC_ACTIONS_INBOX_DIR: "/run/example/inbox",
  MC_ACTIONS_STATE_DIR: "/run/example/state",
};

test("the admin menu is off unless configured, and reads all its variables when it is", () => {
  assert.equal(loadConfig(withServer).admin, null);
  assert.deepEqual(loadConfig({ ...withServer, ...admin }).admin, {
    hostname: "admin.example.com",
    teamDomain: "team.example.com",
    audience: "a".repeat(64),
    inboxDir: "/run/example/inbox",
    stateDir: "/run/example/state",
  });
});

test("a partial or invalid admin configuration fails at startup", () => {
  assert.throws(() => loadConfig({ ...withServer, ADMIN_HOSTNAME: "admin.example.com" }), /missing ACCESS_TEAM_DOMAIN, ACCESS_AUD/);
  assert.throws(() => loadConfig({ ...withServer, ...admin, ADMIN_HOSTNAME: "Admin.Example.com" }), /ADMIN_HOSTNAME must be/);
  assert.throws(() => loadConfig({ ...withServer, ...admin, ACCESS_TEAM_DOMAIN: "https://team.example.com" }), /ACCESS_TEAM_DOMAIN must be/);
  assert.throws(() => loadConfig({ ...withServer, ...admin, ACCESS_AUD: "short" }), /ACCESS_AUD must be/);
  assert.throws(() => loadConfig({ ...withServer, ...admin, MC_ACTIONS_STATE_DIR: "state" }), /MC_ACTIONS_STATE_DIR must be an absolute path/);
  assert.throws(() => loadConfig({ ...required, ...admin }), /needs MC_n_ID set for every/);
  assert.throws(
    () => loadConfig({ ...withServer, ...admin, MC_2_NAME: "B", MC_2_PING: "b.example:25565" }),
    /needs MC_n_ID set for every/,
  );
});

test("OWNER_EMAIL is optional, lower-cased, and must be an email address", () => {
  assert.equal(loadConfig(required).ownerEmail, "");
  assert.equal(loadConfig({ ...required, OWNER_EMAIL: " Owner@Example.com " }).ownerEmail, "owner@example.com");
  assert.throws(() => loadConfig({ ...required, OWNER_EMAIL: "owner" }), /OWNER_EMAIL must be an email address/);
});

test("header and footer links are optional, and must be http or https", () => {
  assert.deepEqual(loadConfig(required).nav, { statusUrl: "", gamesUrl: "", mapUrl: "" });
  assert.deepEqual(
    loadConfig({ ...required, PUBLIC_STATUS_URL: "https://status.example/", PUBLIC_GAMES_URL: "https://games.example/" }).nav,
    { statusUrl: "https://status.example/", gamesUrl: "https://games.example/", mapUrl: "" },
  );
  assert.throws(() => loadConfig({ ...required, PUBLIC_MAP_URL: "javascript:alert(1)" }), /PUBLIC_MAP_URL must be an http or https URL/);
  assert.throws(() => loadConfig({ ...required, PUBLIC_STATUS_URL: "status.example" }), /PUBLIC_STATUS_URL must be an http or https URL/);
});

test("DATABASE_URL is required and never echoed", () => {
  assert.throws(() => loadConfig({}), /^Error: DATABASE_URL must be set$/);
  assert.throws(() => loadConfig({ DATABASE_URL: "" }), /DATABASE_URL must be set/);
});
