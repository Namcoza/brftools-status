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
    MC_3_NAME: "Family",
    MC_3_PING: "family.example:25566",
    MC_3_JOIN: "Java family.example:25566",
    MC_3_MAP_URL: "https://map.example/",
  });
  assert.deepEqual(config.minecraftServers, [
    { name: "Crossplay", host: "crossplay.example", port: 25565, join: "", mapUrl: "" },
    { name: "Family", host: "family.example", port: 25566, join: "Java family.example:25566", mapUrl: "https://map.example/" },
  ]);
});

test("invalid Minecraft configuration fails at startup", () => {
  assert.throws(() => loadConfig({ ...required, MC_1_PING: "mc.example:25565" }), /MC_1_NAME must be set/);
  assert.throws(() => loadConfig({ ...required, MC_2_NAME: "Orphan" }), /MC_2_PING must be set/);
  for (const ping of ["mc.example", "mc.example:0", "mc.example:70000", ":25565", "mc example:25565"]) {
    assert.throws(() => loadConfig({ ...required, MC_1_NAME: "A", MC_1_PING: ping }), /MC_1_PING must be host:port/);
  }
  assert.throws(
    () => loadConfig({ ...required, MC_1_NAME: "A", MC_1_PING: "mc.example:25565", MC_1_MAP_URL: "javascript:alert(1)" }),
    /MC_1_MAP_URL must be an http or https URL/,
  );
});

test("DATABASE_URL is required and never echoed", () => {
  assert.throws(() => loadConfig({}), /^Error: DATABASE_URL must be set$/);
  assert.throws(() => loadConfig({ DATABASE_URL: "" }), /DATABASE_URL must be set/);
});
