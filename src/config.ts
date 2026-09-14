// All configuration is read and validated here, once, at startup.

import type { MinecraftServerConfig } from "./minecraft.ts";

export interface AdminConfig {
  hostname: string;
  teamDomain: string;
  audience: string;
  inboxDir: string;
  stateDir: string;
}

export interface Config {
  port: number;
  appVersion: string;
  databaseUrl: string;
  minecraftServers: MinecraftServerConfig[];
  tailscaleStatusFile: string;
  admin: AdminConfig | null;
}

const MAX_MINECRAFT_SERVERS = 4;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ADMIN_VARIABLES = ["ADMIN_HOSTNAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "MC_ACTIONS_INBOX_DIR", "MC_ACTIONS_STATE_DIR"] as const;

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

  const minecraftServers = loadMinecraftServers(env);

  return {
    port,
    appVersion: env.APP_VERSION || "dev",
    databaseUrl,
    minecraftServers,
    tailscaleStatusFile,
    admin: loadAdmin(env, minecraftServers),
  };
}

// Servers are numbered MC_1_* to MC_4_*. A server exists when its MC_n_PING is set.
function loadMinecraftServers(env: NodeJS.ProcessEnv): MinecraftServerConfig[] {
  const servers: MinecraftServerConfig[] = [];
  for (let n = 1; n <= MAX_MINECRAFT_SERVERS; n++) {
    const prefix = `MC_${n}_`;
    const ping = env[`${prefix}PING`] || "";
    const id = env[`${prefix}ID`] || "";
    const name = env[`${prefix}NAME`] || "";
    const join = env[`${prefix}JOIN`] || "";
    const mapUrl = env[`${prefix}MAP_URL`] || "";

    if (!ping) {
      if (id || name || join || mapUrl) throw new Error(`${prefix}PING must be set when other ${prefix}* variables are`);
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
    if (id && !/^[a-z0-9-]{1,32}$/.test(id)) {
      throw new Error(`${prefix}ID must be 1-32 lower-case letters, digits or hyphens, got "${id}"`);
    }
    if (id && servers.some((server) => server.id === id)) {
      throw new Error(`${prefix}ID "${id}" is already used by another server`);
    }

    servers.push({ id, name, host: match[1], port: pingPort, join, mapUrl });
  }
  return servers;
}

// The private admin menu is on only when every one of its variables is set.
function loadAdmin(env: NodeJS.ProcessEnv, servers: MinecraftServerConfig[]): AdminConfig | null {
  const values = ADMIN_VARIABLES.map((name) => env[name] || "");
  if (values.every((value) => !value)) return null;

  const missing = ADMIN_VARIABLES.filter((_, index) => !values[index]);
  if (missing.length > 0) {
    throw new Error(`The admin menu needs all of ${ADMIN_VARIABLES.join(", ")}; missing ${missing.join(", ")}`);
  }
  const [hostname, teamDomain, audience, inboxDir, stateDir] = values as [string, string, string, string, string];

  if (!HOSTNAME.test(hostname)) throw new Error(`ADMIN_HOSTNAME must be a lower-case hostname, got "${hostname}"`);
  if (!HOSTNAME.test(teamDomain)) throw new Error(`ACCESS_TEAM_DOMAIN must be a lower-case hostname, got "${teamDomain}"`);
  if (!/^[A-Za-z0-9]{16,128}$/.test(audience)) throw new Error("ACCESS_AUD must be the Access application's audience tag");
  for (const [name, dir] of [
    ["MC_ACTIONS_INBOX_DIR", inboxDir],
    ["MC_ACTIONS_STATE_DIR", stateDir],
  ] as const) {
    if (!dir.startsWith("/")) throw new Error(`${name} must be an absolute path, got "${dir}"`);
  }
  if (servers.length === 0 || servers.some((server) => !server.id)) {
    throw new Error("The admin menu needs MC_n_ID set for every configured Minecraft server");
  }

  return { hostname, teamDomain, audience, inboxDir, stateDir };
}
