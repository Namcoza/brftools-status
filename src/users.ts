import type { Pool } from "pg";

// People invited to the status page, keyed by the Google account email Cloudflare Access
// reports for them. The owner is configured (OWNER_EMAIL) and never stored. See README,
// "Users".

export interface User {
  email: string;
  addedAt: Date;
  // Null until they first sign in: an invitation not yet taken up.
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

export interface UserStore {
  list(): Promise<User[]>;
  // False when the email is already on the list.
  add(email: string): Promise<boolean>;
  // False when the email was not on the list.
  remove(email: string): Promise<boolean>;
  // A signed-in visit to the status page: true when the email is invited, recording the first
  // visit and, at most every few minutes, the latest one.
  visit(email: string): Promise<boolean>;
}

// Pages reload every minute; recording each reload would be a write per viewer per minute.
const LAST_SEEN_EVERY_MS = 5 * 60_000;

// Deliberately loose: Google decides what a valid account is. This only keeps obvious typos
// and oversized input out of the table.
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_EMAIL_LENGTH = 254;

// Lower-cased and trimmed, or null when it cannot be an email address.
export function normaliseEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null;
}

export function createUserStore(pool: Pool): UserStore {
  return {
    async list() {
      const { rows } = await pool.query<{ email: string; added_at: Date; first_seen_at: Date | null; last_seen_at: Date | null }>(
        "SELECT email, added_at, first_seen_at, last_seen_at FROM users ORDER BY added_at DESC, email",
      );
      return rows.map((row) => ({
        email: row.email,
        addedAt: row.added_at,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }));
    },
    async add(email) {
      const { rowCount } = await pool.query("INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING", [email]);
      return rowCount === 1;
    },
    async remove(email) {
      const { rowCount } = await pool.query("DELETE FROM users WHERE email = $1", [email]);
      return rowCount === 1;
    },
    async visit(email) {
      const { rows } = await pool.query<{ last_seen_at: Date | null }>("SELECT last_seen_at FROM users WHERE email = $1", [email]);
      const row = rows[0];
      if (!row) return false;
      if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() >= LAST_SEEN_EVERY_MS) {
        await pool.query("UPDATE users SET first_seen_at = COALESCE(first_seen_at, now()), last_seen_at = now() WHERE email = $1", [email]);
      }
      return true;
    },
  };
}
