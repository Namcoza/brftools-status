import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("defaults apply when variables are unset", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.appVersion, "dev");
});

test("empty values count as unset", () => {
  const config = loadConfig({ PORT: "", APP_VERSION: "" });
  assert.equal(config.port, 3000);
  assert.equal(config.appVersion, "dev");
});

test("an invalid PORT fails at startup", () => {
  assert.throws(() => loadConfig({ PORT: "not-a-port" }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT must be an integer/);
});
