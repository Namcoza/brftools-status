// All configuration is read and validated here, once, at startup.
import { resolve } from "node:path";

export interface Config {
  port: number;
  appVersion: string;
  publicDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values count as unset, so a copied .env.example behaves like no .env at all.
  const port = Number(env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}"`);
  }

  return {
    port,
    appVersion: env.APP_VERSION || "dev",
    publicDir: resolve(env.PUBLIC_DIR || "public"),
  };
}
