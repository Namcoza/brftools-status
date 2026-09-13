import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import type { Pool } from "pg";

export type { Pool };

export interface Release {
  version: string;
  startedAt: Date;
}

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000 });
}

// Applies migrations/*.sql in name order, each exactly once. Everything runs in one
// transaction under an advisory lock, so two containers starting together cannot race.
export async function migrate(pool: Pool, dir: URL): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('brftools-status:migrate'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const alreadyApplied = new Set(rows.map((row) => row.name));

    const applied: string[] = [];
    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      await client.query(await readFile(new URL(file, dir), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }

    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordRelease(pool: Pool, version: string): Promise<void> {
  await pool.query("INSERT INTO releases (version) VALUES ($1)", [version]);
}

export async function listReleases(pool: Pool, limit = 50): Promise<Release[]> {
  const { rows } = await pool.query<{ version: string; started_at: Date }>(
    "SELECT version, started_at FROM releases ORDER BY started_at DESC, id DESC LIMIT $1",
    [limit],
  );
  return rows.map((row) => ({ version: row.version, startedAt: row.started_at }));
}

export async function isDatabaseReachable(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
