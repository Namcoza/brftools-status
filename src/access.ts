import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

// Cloudflare Access adds a signed JWT, Cf-Access-Jwt-Assertion, to every request that passed its
// login. The admin menu verifies it here, on every request, so that reaching the app any other
// way — the LAN port, a forged Host header, a mistake in the Access dashboard — gets nothing.
// Signing keys: https://<team domain>/cdn-cgi/access/certs.

export interface AccessIdentity {
  email: string;
}

export interface AccessVerifier {
  verify(token: string | undefined): Promise<AccessIdentity>;
}

export class AccessError extends Error {}

export type FetchJson = (url: string) => Promise<unknown>;

const CLOCK_SKEW_S = 60;
const KEYS_MAX_AGE_MS = 60 * 60_000;
// A token naming a key we don't have triggers a refetch (keys rotate), but no more often than this.
const UNKNOWN_KID_REFETCH_MS = 5 * 60_000;

export function createAccessVerifier({
  teamDomain,
  audience,
  fetchJson = fetchCerts,
  now = () => Date.now(),
}: {
  teamDomain: string;
  audience: string;
  fetchJson?: FetchJson;
  now?: () => number;
}): AccessVerifier {
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = -Infinity;

  async function refresh(): Promise<void> {
    fetchedAt = now();
    const body = (await fetchJson(certsUrl)) as { keys?: unknown } | null;
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      const { kid, kty } = (jwk ?? {}) as { kid?: unknown; kty?: unknown };
      if (typeof kid !== "string" || kty !== "RSA") continue;
      try {
        next.set(kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
      } catch {
        // An unusable key is skipped; the others still work.
      }
    }
    if (next.size === 0) throw new AccessError("no usable signing keys from Access");
    keys = next;
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    if (keys.size === 0 || now() - fetchedAt > KEYS_MAX_AGE_MS) await refresh();
    let key = keys.get(kid);
    if (!key && now() - fetchedAt > UNKNOWN_KID_REFETCH_MS) {
      await refresh();
      key = keys.get(kid);
    }
    if (!key) throw new AccessError("token signed by an unknown key");
    return key;
  }

  return {
    async verify(token) {
      if (!token) throw new AccessError("no Access token");
      const parts = token.split(".");
      if (parts.length !== 3) throw new AccessError("malformed token");
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

      const header = decodePart(headerPart);
      if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessError("unsupported token algorithm");
      const key = await keyFor(header.kid);
      const signed = Buffer.from(`${headerPart}.${payloadPart}`);
      if (!verify("RSA-SHA256", signed, key, Buffer.from(signaturePart, "base64url"))) {
        throw new AccessError("bad token signature");
      }

      const claims = decodePart(payloadPart);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(audience)) throw new AccessError("token is for another application");
      if (claims.iss !== issuer) throw new AccessError("token from another issuer");
      const seconds = now() / 1000;
      if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < seconds) throw new AccessError("token expired");
      if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > seconds) throw new AccessError("token not yet valid");
      if (typeof claims.email !== "string" || !claims.email) throw new AccessError("token has no email");
      return { email: claims.email };
    },
  };
}

function decodePart(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Fall through to the error below.
  }
  throw new AccessError("malformed token");
}

async function fetchCerts(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new AccessError(`fetching Access signing keys failed with ${res.status}`);
  return res.json();
}
