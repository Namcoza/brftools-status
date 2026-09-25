import type { IncomingMessage } from "node:http";
import { AccessError, type AccessVerifier } from "./access.ts";
import type { UserStore } from "./users.ts";

// Sign-in for the status page. Cloudflare Access (Google login) proves who the visitor is and
// adds a signed token to the request; this checks the token on every request, as the admin menu
// does, then lets in the owner and anyone on the users list. So reaching the app another way —
// the LAN port, a mistake in the Access dashboard — gets nothing. See README, "Sign-in".

export type Visitor =
  | { kind: "owner"; email: string }
  | { kind: "user"; email: string }
  // Signed in to Google, but not invited.
  | { kind: "uninvited"; email: string }
  | { kind: "anonymous"; reason: string };

export interface StatusGate {
  check(req: IncomingMessage): Promise<Visitor>;
}

export function createStatusGate({
  verifier,
  ownerEmail,
  users,
}: {
  verifier: AccessVerifier;
  ownerEmail: string;
  users: UserStore;
}): StatusGate {
  return {
    async check(req) {
      let email: string;
      try {
        email = (await verifier.verify(header(req, "cf-access-jwt-assertion"))).email.toLowerCase();
      } catch (error) {
        const reason = error instanceof AccessError ? error.message : `verification failed: ${(error as Error).message}`;
        return { kind: "anonymous", reason };
      }
      if (email === ownerEmail) return { kind: "owner", email };
      return (await users.visit(email)) ? { kind: "user", email } : { kind: "uninvited", email };
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
