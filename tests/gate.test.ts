import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { AccessError, type AccessVerifier } from "../src/access.ts";
import { createStatusGate } from "../src/gate.ts";
import type { UserStore } from "../src/users.ts";

// Stands in for Cloudflare Access; the real verification is tested in access.test.ts.
const emails: Record<string, string> = { owner: "Owner@Example.com", friend: "Friend@Example.com", stranger: "stranger@example.com" };
const verifier: AccessVerifier = {
  async verify(token) {
    const email = token ? emails[token] : undefined;
    if (!email) throw new AccessError(token ? "bad token signature" : "no Access token");
    return { email };
  },
};

const visited: string[] = [];
const users: UserStore = {
  list: async () => [],
  add: async () => true,
  remove: async () => true,
  async visit(email) {
    visited.push(email);
    return email === "friend@example.com";
  },
};

const gate = createStatusGate({ verifier, ownerEmail: "owner@example.com", users });
const request = (token?: string) => ({ headers: token ? { "cf-access-jwt-assertion": token } : {} }) as IncomingMessage;

test("the owner is let in without being on the list", async () => {
  assert.deepEqual(await gate.check(request("owner")), { kind: "owner", email: "owner@example.com" });
  assert.deepEqual(visited, []);
});

test("an invited user is let in, matched case-insensitively, and the visit is recorded", async () => {
  assert.deepEqual(await gate.check(request("friend")), { kind: "user", email: "friend@example.com" });
  assert.deepEqual(visited.at(-1), "friend@example.com");
});

test("a Google account that is not on the list is not let in", async () => {
  assert.deepEqual(await gate.check(request("stranger")), { kind: "uninvited", email: "stranger@example.com" });
});

test("a missing or forged token is anonymous", async () => {
  assert.deepEqual(await gate.check(request()), { kind: "anonymous", reason: "no Access token" });
  assert.deepEqual(await gate.check(request("forged")), { kind: "anonymous", reason: "bad token signature" });
});
