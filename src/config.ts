// All configuration is read and validated here, once, at startup.

export interface Config {
  port: number;
  appVersion: string;
  databaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values count as unset, so a copied .env.example behaves like no .env at all.
  const port = Number(env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}"`);
  }

  // Never include the value in the message: it contains the database password.
  const databaseUrl = env.DATABASE_URL || "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set");
  }

  return {
    port,
    appVersion: env.APP_VERSION || "dev",
    databaseUrl,
  };
}
