import { createAccessVerifier } from "./access.ts";
import { createAdminHandler } from "./admin.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool, migrate, recordRelease } from "./db.ts";
import { createMediaMonitor } from "./media.ts";
import { createMonitor } from "./minecraft.ts";
import { readTailscale } from "./tailscale.ts";
import { createUserStore } from "./users.ts";

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

// Read-only checks of the media services; no credentials, and nothing is shown publicly but state.
const media = createMediaMonitor(config.mediaServices);
media.start();

const { tailscaleStatusFile, admin } = config;
const server = createApp(config, pool, {
  minecraft: minecraft.statuses,
  media: media.statuses,
  tailscale: tailscaleStatusFile ? () => readTailscale(tailscaleStatusFile) : undefined,
  // The private admin menu: only on its own hostname, only with a valid Access token.
  admin: admin
    ? {
        hostname: admin.hostname,
        handle: createAdminHandler({
          hostname: admin.hostname,
          verifier: createAccessVerifier({ teamDomain: admin.teamDomain, audience: admin.audience }),
          servers: config.minecraftServers,
          minecraft: minecraft.statuses,
          mediaServices: config.mediaServices,
          media: media.statuses,
          inboxDir: admin.inboxDir,
          stateDir: admin.stateDir,
          nav: config.nav,
          ownerEmail: config.ownerEmail,
          users: createUserStore(pool),
        }),
      }
    : undefined,
});
if (admin) console.log(`admin menu enabled for ${admin.hostname}`);
// Without an owner, anyone the admin Access policy lets in can use the menu, users page included.
if (admin && !config.ownerEmail) console.warn("OWNER_EMAIL is not set: the admin menu relies on the Access policy alone");
server.listen(config.port, () => {
  console.log(`listening on port ${config.port} (version ${config.appVersion})`);
});

// Docker sends SIGTERM on stop; finish in-flight requests, then close the pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    minecraft.stop();
    media.stop();
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
