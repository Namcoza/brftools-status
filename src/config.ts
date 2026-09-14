// All configuration is read and validated here, once, at startup.

import type { MinecraftServerConfig } from "./minecraft.ts";

export interface Config {
  port: number;
  appVersion: string;
  databaseUrl: string;
  minecraftServers: MinecraftServerConfig[];
  tailscaleStatusFile: string;
}

const MAX_MINECRAFT_SERVERS = 4;

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

  // Written by a timer on the host and mounted read-only; unset hides the Tailscale section.
  const tailscaleStatusFile = env.TAILSCALE_STATUS_FILE || "";
  if (tailscaleStatusFile && !tailscaleStatusFile.startsWith("/")) {
    throw new Error(`TAILSCALE_STATUS_FILE must be an absolute path, got "${tailscaleStatusFile}"`);
  }

  return {
    port,
    appVersion: env.APP_VERSION || "dev",
    databaseUrl,
    minecraftServers: loadMinecraftServers(env),
    tailscaleStatusFile,
  };
}

// Servers are numbered MC_1_* to MC_4_*. A server exists when its MC_n_PING is set.
function loadMinecraftServers(env: NodeJS.ProcessEnv): MinecraftServerConfig[] {
  const servers: MinecraftServerConfig[] = [];
  for (let n = 1; n <= MAX_MINECRAFT_SERVERS; n++) {
    const prefix = `MC_${n}_`;
    const ping = env[`${prefix}PING`] || "";
    const name = env[`${prefix}NAME`] || "";
    const join = env[`${prefix}JOIN`] || "";
    const mapUrl = env[`${prefix}MAP_URL`] || "";

    if (!ping) {
      if (name || join || mapUrl) throw new Error(`${prefix}PING must be set when other ${prefix}* variables are`);
      continue;
    }
    if (!name) throw new Error(`${prefix}NAME must be set when ${prefix}PING is`);

    const match = /^([^\s:]+):(\d{1,5})$/.exec(ping);
    const pingPort = Number(match?.[2]);
    if (!match?.[1] || pingPort < 1 || pingPort > 65535) {
      throw new Error(`${prefix}PING must be host:port, got "${ping}"`);
    }
    if (mapUrl && !/^https?:$/.test(URL.parse(mapUrl)?.protocol ?? "")) {
      throw new Error(`${prefix}MAP_URL must be an http or https URL, got "${mapUrl}"`);
    }

    servers.push({ name, host: match[1], port: pingPort, join, mapUrl });
  }
  return servers;
}
