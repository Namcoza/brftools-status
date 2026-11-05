import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVICE_META, serviceMeta } from "../src/service-meta.ts";

test("every described service has a role and a description", () => {
  for (const [id, meta] of Object.entries(SERVICE_META)) {
    assert.ok(meta.role, `${id} role`);
    assert.ok(meta.description, `${id} description`);
  }
});

// This repository is public (AGENTS.md): descriptions never carry an address.
test("no description names an address, port or URL", () => {
  for (const [id, meta] of Object.entries(SERVICE_META)) {
    const text = `${meta.role} ${meta.description}`;
    assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b|https?:\/\/|:\d{2,5}\b/, id);
  }
});

test("the local LLM card is described, and an unknown service still renders without one", () => {
  assert.equal(serviceMeta("llm").group, "other");
  assert.equal(serviceMeta("llm").role, "Local chat model");
  assert.deepEqual(serviceMeta("not-configured"), { group: "other", role: "", description: "" });
});
