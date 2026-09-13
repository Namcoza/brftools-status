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

test("DATABASE_URL is required and never echoed", () => {
  assert.throws(() => loadConfig({}), /^Error: DATABASE_URL must be set$/);
  assert.throws(() => loadConfig({ DATABASE_URL: "" }), /DATABASE_URL must be set/);
});
