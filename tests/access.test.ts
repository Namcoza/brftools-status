import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, test } from "node:test";
import { createAccessVerifier } from "../src/access.ts";

const teamDomain = "team.example.com";
const audience = "a".repeat(64);
const issuer = `https://${teamDomain}`;
const start = Date.parse("2026-09-14T12:00:00Z");

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function testKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

const current = testKey("key-1");
const rotated = testKey("key-2");

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(claims: Record<string, unknown> = {}, { key = current, header = {} as Record<string, unknown> } = {}): string {
  const seconds = start / 1000;
  const head = part({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = part({ aud: [audience], iss: issuer, email: "owner@example.com", iat: seconds, nbf: seconds, exp: seconds + 600, ...claims });
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}

function setup({ keys = [current.jwk], fail = false } = {}) {
  const clock = { now: start };
  const published = { keys };
  const fetches: string[] = [];
  const verifier = createAccessVerifier({
    teamDomain,
    audience,
    now: () => clock.now,
    fetchJson: async (url) => {
      fetches.push(url);
      if (fail) throw new Error("network down");
      return { keys: published.keys, public_cert: {}, public_certs: [] };
    },
  });
  return { verifier, clock, published, fetches };
}

describe("Access token verification", () => {
  test("accepts a valid token, and fetches the team's keys once", async () => {
    const { verifier, fetches } = setup();
    assert.deepEqual(await verifier.verify(token()), { email: "owner@example.com" });
    assert.deepEqual(await verifier.verify(token({ aud: audience })), { email: "owner@example.com" });
    assert.deepEqual(fetches, ["https://team.example.com/cdn-cgi/access/certs"]);
  });

  test("rejects a missing or malformed token", async () => {
    const { verifier } = setup();
    await assert.rejects(verifier.verify(undefined), /no Access token/);
    await assert.rejects(verifier.verify(""), /no Access token/);
    await assert.rejects(verifier.verify("not-a-token"), /malformed token/);
    await assert.rejects(verifier.verify("a.b.c"), /malformed token/);
  });

  test("rejects anything but RS256", async () => {
    const { verifier } = setup();
    const unsigned = `${part({ alg: "none", kid: current.kid })}.${part({ aud: [audience], iss: issuer, email: "x@example.com", exp: start / 1000 + 600 })}.`;
    await assert.rejects(verifier.verify(unsigned), /unsupported token algorithm/);
    await assert.rejects(verifier.verify(token({}, { header: { alg: "HS256" } })), /unsupported token algorithm/);
  });

  test("rejects a bad signature or a tampered payload", async () => {
    const { verifier } = setup();
    // Signed with another key but claiming to be key-1.
    const forged = token({}, { key: { ...rotated, kid: current.kid } });
    await assert.rejects(verifier.verify(forged), /bad token signature/);
    const [head, , signature] = token().split(".");
    const tampered = `${head}.${part({ aud: [audience], iss: issuer, email: "intruder@example.com", exp: start / 1000 + 600 })}.${signature}`;
    await assert.rejects(verifier.verify(tampered), /bad token signature/);
  });

  test("rejects the wrong audience or issuer, and a missing email", async () => {
    const { verifier } = setup();
    await assert.rejects(verifier.verify(token({ aud: ["b".repeat(64)] })), /another application/);
    await assert.rejects(verifier.verify(token({ iss: "https://other.example.com" })), /another issuer/);
    await assert.rejects(verifier.verify(token({ email: undefined })), /no email/);
  });

  test("checks expiry and not-before, allowing 60 seconds of clock skew", async () => {
    const { verifier } = setup();
    const seconds = start / 1000;
    assert.ok(await verifier.verify(token({ exp: seconds - 30 })));
    await assert.rejects(verifier.verify(token({ exp: seconds - 120 })), /expired/);
    await assert.rejects(verifier.verify(token({ exp: undefined })), /expired/);
    assert.ok(await verifier.verify(token({ nbf: seconds + 30 })));
    await assert.rejects(verifier.verify(token({ nbf: seconds + 120 })), /not yet valid/);
  });

  test("follows key rotation, but refetches for unknown keys at most every 5 minutes", async () => {
    const { verifier, clock, published, fetches } = setup();
    assert.ok(await verifier.verify(token()));
    published.keys = [current.jwk, rotated.jwk];

    clock.now = start + 60_000;
    await assert.rejects(verifier.verify(token({ exp: start / 1000 + 3600 }, { key: rotated })), /unknown key/);
    assert.equal(fetches.length, 1);

    clock.now = start + 6 * 60_000;
    assert.ok(await verifier.verify(token({ exp: start / 1000 + 3600 }, { key: rotated })));
    assert.equal(fetches.length, 2);
  });

  test("fails closed when the keys cannot be fetched or none are usable", async () => {
    await assert.rejects(setup({ fail: true }).verifier.verify(token()), /network down/);
    await assert.rejects(setup({ keys: [{ kid: "x", kty: "EC" }] }).verifier.verify(token()), /no usable signing keys/);
  });
});
