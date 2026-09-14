import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool, migrate, recordRelease } from "./db.ts";
import { createMonitor } from "./minecraft.ts";
import { readTailscale } from "./tailscale.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

// migrations/ sits beside src/ in development and beside dist/ in the image.
const migrationsDir = new URL("../migrations/", import.meta.url);

// The database may be starting or briefly restarting; retry before giving up.
const applied = await withRetry(() => migrate(pool, migrationsDir));
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.join(", ")}`);
}
await recordRelease(pool, config.appVersion);

// Pings the configured Minecraft servers in the background; does nothing if none are.
const minecraft = createMonitor(config.minecraftServers);
minecraft.start();

const { tailscaleStatusFile } = config;
const server = createApp(config, pool, {
  minecraft: minecraft.statuses,
  tailscale: tailscaleStatusFile ? () => readTailscale(tailscaleStatusFile) : undefined,
});
server.listen(config.port, () => {
  console.log(`listening on port ${config.port} (version ${config.appVersion})`);
});

// Docker sends SIGTERM on stop; finish in-flight requests, then close the pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    minecraft.stop();
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}

// Connection failures arrive as an AggregateError with an empty message, so fall back
// to the error code. Never print the connection string: it contains the password.
function describeError(error: unknown): string {
  const { message, code } = error as { message?: string; code?: string };
  return message || code || String(error);
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 10, delayMs = 2000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.error(`database not ready (attempt ${attempt}/${attempts}): ${describeError(error)}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
