// All configuration is read and validated here, once, at startup.

import { MEDIA_KINDS, type MediaKind, type MediaServiceConfig } from "./media.ts";
import type { MinecraftServerConfig } from "./minecraft.ts";
import { normaliseEmail } from "./users.ts";

export interface AdminConfig {
  hostname: string;
  teamDomain: string;
  audience: string;
  inboxDir: string;
  stateDir: string;
}

// Sign-in on the status page itself: a second Cloudflare Access application, on the same team.
export interface StatusAccessConfig {
  teamDomain: string;
  audience: string;
}

// Links in the shared header and footer, so every surface knows about the others.
export interface NavConfig {
  statusUrl: string;
  gamesUrl: string;
  mapUrl: string;
}

// Decorative, non-monitored facts for the Overview and Media tabs: drive usage, hardware
// labels, open issues and the "who can reach what" table. Nothing here is read by a monitor,
// and none of it belongs in this public repository (see AGENTS.md, "This repository is
// public") — it comes from one JSON blob in production config instead. Unset hides it all.
export interface DriveUsage {
  usedTb: number;
  totalTb: number;
}

export interface HardwareFact {
  label: string;
  value: string;
  detail: string;
}

export interface HomeIssue {
  tag: "fix" | "waiting" | "note";
  title: string;
  body: string;
}

export interface ReachRow {
  name: string;
  home: string;
  tail: string;
  any: string;
  anyOk: boolean;
  note: string;
}

export interface HomeFacts {
  drive: DriveUsage | null;
  hardware: HardwareFact[];
  issues: HomeIssue[];
  reach: ReachRow[];
}

const EMPTY_HOME_FACTS: HomeFacts = { drive: null, hardware: [], issues: [], reach: [] };
const MAX_LIST_ITEMS = 8;
const ISSUE_TAGS = ["fix", "waiting", "note"] as const;

export interface Config {
  port: number;
  appVersion: string;
  databaseUrl: string;
  minecraftServers: MinecraftServerConfig[];
  mediaServices: MediaServiceConfig[];
  tailscaleStatusFile: string;
  admin: AdminConfig | null;
  // The owner's Google account email, lower-cased; "" when unset. Only this account may use the
  // admin menu, and it always has access without being on the users list.
  ownerEmail: string;
  // Null leaves the status page public.
  statusAccess: StatusAccessConfig | null;
  nav: NavConfig;
  homeFacts: HomeFacts;
}

const MAX_MINECRAFT_SERVERS = 4;
const MAX_MEDIA_SERVICES = 12;
const SLUG = /^[a-z0-9-]{1,32}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ADMIN_VARIABLES = ["ADMIN_HOSTNAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "MC_ACTIONS_INBOX_DIR", "MC_ACTIONS_STATE_DIR"] as const;
const AUDIENCE = /^[A-Za-z0-9]{16,128}$/;

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
  const ownerEmail = loadOwnerEmail(env);

  return {
    port,
    appVersion: env.APP_VERSION || "dev",
    databaseUrl,
    minecraftServers,
    mediaServices: loadMediaServices(env),
    tailscaleStatusFile,
    admin: loadAdmin(env, minecraftServers),
    ownerEmail,
    statusAccess: loadStatusAccess(env, ownerEmail),
    nav: loadNav(env),
    homeFacts: loadHomeFacts(env),
  };
}

// One JSON object, so the shape can grow without a wall of numbered variables for content
// that drives no behaviour. Absent or empty means the sections it feeds are hidden.
function loadHomeFacts(env: NodeJS.ProcessEnv): HomeFacts {
  const raw = env.HOME_FACTS_JSON || "";
  if (!raw) return EMPTY_HOME_FACTS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HOME_FACTS_JSON must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("HOME_FACTS_JSON must be a JSON object");
  const value = parsed as Record<string, unknown>;

  const drive = value.drive;
  let driveUsage: DriveUsage | null = null;
  if (drive !== undefined && drive !== null) {
    const { usedTb, totalTb } = (drive ?? {}) as Record<string, unknown>;
    if (typeof usedTb !== "number" || typeof totalTb !== "number" || !(usedTb >= 0) || !(totalTb > 0)) {
      throw new Error("HOME_FACTS_JSON.drive needs numeric usedTb and totalTb, with totalTb > 0");
    }
    driveUsage = { usedTb, totalTb };
  }

  const hardware = list(value.hardware, "hardware").map((item, i) => ({
    label: str(item, "label", `hardware[${i}]`),
    value: str(item, "value", `hardware[${i}]`),
    detail: str(item, "detail", `hardware[${i}]`, true),
  }));

  const issues = list(value.issues, "issues").map((item, i) => {
    const tag = str(item, "tag", `issues[${i}]`);
    if (!ISSUE_TAGS.includes(tag as (typeof ISSUE_TAGS)[number])) {
      throw new Error(`HOME_FACTS_JSON.issues[${i}].tag must be one of ${ISSUE_TAGS.join(", ")}, got "${tag}"`);
    }
    return { tag: tag as HomeIssue["tag"], title: str(item, "title", `issues[${i}]`), body: str(item, "body", `issues[${i}]`) };
  });

  const reach = list(value.reach, "reach").map((item, i) => ({
    name: str(item, "name", `reach[${i}]`),
    home: str(item, "home", `reach[${i}]`),
    tail: str(item, "tail", `reach[${i}]`),
    any: str(item, "any", `reach[${i}]`),
    anyOk: bool(item, "anyOk", `reach[${i}]`),
    note: str(item, "note", `reach[${i}]`, true),
  }));

  return { drive: driveUsage, hardware, issues, reach };
}

function list(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`HOME_FACTS_JSON.${field} must be an array`);
  if (value.length > MAX_LIST_ITEMS) throw new Error(`HOME_FACTS_JSON.${field} must have at most ${MAX_LIST_ITEMS} items`);
  return value.map((item, i) => {
    if (typeof item !== "object" || item === null) throw new Error(`HOME_FACTS_JSON.${field}[${i}] must be an object`);
    return item as Record<string, unknown>;
  });
}

function str(item: Record<string, unknown>, field: string, path: string, optional = false): string {
  const value = item[field];
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || !value) throw new Error(`HOME_FACTS_JSON.${path}.${field} must be a non-empty string`);
  return value;
}

function bool(item: Record<string, unknown>, field: string, path: string): boolean {
  const value = item[field];
  if (typeof value !== "boolean") throw new Error(`HOME_FACTS_JSON.${path}.${field} must be a boolean`);
  return value;
}

// Numbered MEDIA_1_* to MEDIA_12_*. A service exists when its MEDIA_n_CHECK is set.
function loadMediaServices(env: NodeJS.ProcessEnv): MediaServiceConfig[] {
  const services: MediaServiceConfig[] = [];
  for (let n = 1; n <= MAX_MEDIA_SERVICES; n++) {
    const prefix = `MEDIA_${n}_`;
    const checkUrl = env[`${prefix}CHECK`] || "";
    const id = env[`${prefix}ID`] || "";
    const name = env[`${prefix}NAME`] || "";
    const kind = env[`${prefix}KIND`] || "";
    const url = env[`${prefix}URL`] || "";
    const lanUrl = env[`${prefix}LAN_URL`] || "";

    if (!checkUrl) {
      if (id || name || kind || url || lanUrl) throw new Error(`${prefix}CHECK must be set when other ${prefix}* variables are`);
      continue;
    }
    for (const [suffix, value] of [
      ["ID", id],
      ["NAME", name],
      ["KIND", kind],
      ["URL", url],
    ] as const) {
      if (!value) throw new Error(`${prefix}${suffix} must be set when ${prefix}CHECK is`);
    }
    if (!SLUG.test(id)) throw new Error(`${prefix}ID must be 1-32 lower-case letters, digits or hyphens, got "${id}"`);
    if (services.some((service) => service.id === id)) throw new Error(`${prefix}ID "${id}" is already used by another service`);
    if (!MEDIA_KINDS.includes(kind as MediaKind)) {
      throw new Error(`${prefix}KIND must be one of ${MEDIA_KINDS.join(", ")}, got "${kind}"`);
    }
    for (const [suffix, value] of [
      ["CHECK", checkUrl],
      ["URL", url],
      ["LAN_URL", lanUrl],
    ] as const) {
      if (value && !/^https?:$/.test(URL.parse(value)?.protocol ?? "")) {
        throw new Error(`${prefix}${suffix} must be an http or https URL, got "${value}"`);
      }
    }

    services.push({ id, name, kind: kind as MediaKind, checkUrl, url, lanUrl });
  }
  return services;
}

// Absolute URLs for the header and footer. Unset links are simply left out; the Status link
// falls back to "/" so the public page always has its own anchor.
function loadNav(env: NodeJS.ProcessEnv): NavConfig {
  const urls = { statusUrl: env.PUBLIC_STATUS_URL || "", gamesUrl: env.PUBLIC_GAMES_URL || "", mapUrl: env.PUBLIC_MAP_URL || "" };
  for (const [key, value] of Object.entries(urls)) {
    const name = `PUBLIC_${key.replace(/Url$/, "").toUpperCase()}_URL`;
    if (value && !/^https?:$/.test(URL.parse(value)?.protocol ?? "")) {
      throw new Error(`${name} must be an http or https URL, got "${value}"`);
    }
  }
  return urls;
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

function loadOwnerEmail(env: NodeJS.ProcessEnv): string {
  const raw = env.OWNER_EMAIL || "";
  if (!raw) return "";
  const email = normaliseEmail(raw);
  if (!email) throw new Error(`OWNER_EMAIL must be an email address, got "${raw}"`);
  return email;
}

// On only when STATUS_ACCESS_AUD is set. It needs the owner, so that turning sign-in on can
// never lock the owner out along with everyone else.
function loadStatusAccess(env: NodeJS.ProcessEnv, ownerEmail: string): StatusAccessConfig | null {
  const audience = env.STATUS_ACCESS_AUD || "";
  if (!audience) return null;
  const teamDomain = env.ACCESS_TEAM_DOMAIN || "";
  if (!teamDomain) throw new Error("STATUS_ACCESS_AUD needs ACCESS_TEAM_DOMAIN");
  if (!HOSTNAME.test(teamDomain)) throw new Error(`ACCESS_TEAM_DOMAIN must be a lower-case hostname, got "${teamDomain}"`);
  if (!AUDIENCE.test(audience)) throw new Error("STATUS_ACCESS_AUD must be the status Access application's audience tag");
  if (!ownerEmail) throw new Error("STATUS_ACCESS_AUD needs OWNER_EMAIL");
  if (audience === env.ACCESS_AUD) throw new Error("STATUS_ACCESS_AUD must be a different Access application from ACCESS_AUD");
  return { teamDomain, audience };
}

// The private admin menu is on only when every one of its variables is set.
function loadAdmin(env: NodeJS.ProcessEnv, servers: MinecraftServerConfig[]): AdminConfig | null {
  const values = ADMIN_VARIABLES.map((name) => env[name] || "");
  // ACCESS_TEAM_DOMAIN is shared with the status page's sign-in, so on its own it does not
  // switch the admin menu on.
  if (ADMIN_VARIABLES.every((name, index) => name === "ACCESS_TEAM_DOMAIN" || !values[index])) return null;

  const missing = ADMIN_VARIABLES.filter((_, index) => !values[index]);
  if (missing.length > 0) {
    throw new Error(`The admin menu needs all of ${ADMIN_VARIABLES.join(", ")}; missing ${missing.join(", ")}`);
  }
  const [hostname, teamDomain, audience, inboxDir, stateDir] = values as [string, string, string, string, string];

  if (!HOSTNAME.test(hostname)) throw new Error(`ADMIN_HOSTNAME must be a lower-case hostname, got "${hostname}"`);
  if (!HOSTNAME.test(teamDomain)) throw new Error(`ACCESS_TEAM_DOMAIN must be a lower-case hostname, got "${teamDomain}"`);
  if (!AUDIENCE.test(audience)) throw new Error("ACCESS_AUD must be the Access application's audience tag");
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
