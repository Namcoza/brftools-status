import { connect } from "node:net";

// Minecraft's Server List Ping: the status query a game client sends to show a server
// in its list. It needs no credential. Protocol reference:
// https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping

export interface MinecraftServerConfig {
  name: string;
  host: string;
  port: number;
  join: string;
  mapUrl: string;
}

export interface PingResult {
  motd: string;
  version: string;
  playersOnline: number;
  playersMax: number;
}

export interface ServerStatus {
  server: MinecraftServerConfig;
  state: "unknown" | "online" | "offline";
  checkedAt: Date | null;
  result: PingResult | null;
}

export type Ping = (host: string, port: number, timeoutMs: number) => Promise<PingResult>;

// A status response carries the server icon as a data URI, so allow for that, but no more.
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

// Returns null when the buffer ends before the VarInt does.
export function decodeVarInt(buffer: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buffer[offset + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value: value | 0, size: i + 1 };
  }
  throw new Error("VarInt is longer than 5 bytes");
}

function packet(id: number, ...fields: Buffer[]): Buffer {
  const body = Buffer.concat([encodeVarInt(id), ...fields]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function handshake(host: string, port: number): Buffer {
  const address = Buffer.from(host, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  // Protocol version -1 means "not joining, any version"; next state 1 is status.
  return packet(0x00, encodeVarInt(-1), encodeVarInt(address.length), address, portBytes, encodeVarInt(1));
}

// Returns the JSON text of a complete status response packet, or null if more bytes are needed.
export function readStatusResponse(buffer: Buffer): string | null {
  const length = decodeVarInt(buffer);
  if (!length || buffer.length < length.size + length.value) return null;
  const end = length.size + length.value;

  let offset = length.size;
  const id = decodeVarInt(buffer, offset);
  if (!id || id.value !== 0x00) throw new Error("unexpected packet in status response");
  offset += id.size;

  const text = decodeVarInt(buffer, offset);
  if (!text || offset + text.size + text.value > end) throw new Error("malformed status response");
  offset += text.size;
  return buffer.toString("utf8", offset, offset + text.value);
}

// Deliberately ignores players.sample: player names are not shown on the public page.
export function parseStatus(json: string): PingResult {
  const status = (JSON.parse(json) ?? {}) as {
    description?: unknown;
    version?: { name?: unknown };
    players?: { online?: unknown; max?: unknown };
  };
  return {
    motd: flattenText(status.description)
      .replace(/§./gu, "")
      .replace(/\s+/g, " ")
      .trim(),
    version: typeof status.version?.name === "string" ? status.version.name : "",
    playersOnline: toCount(status.players?.online),
    playersMax: toCount(status.players?.max),
  };
}

// The MOTD is either a plain string or a JSON text component with nested "extra" parts.
function flattenText(component: unknown): string {
  if (typeof component === "string") return component;
  if (Array.isArray(component)) return component.map(flattenText).join("");
  if (component && typeof component === "object") {
    const { text, extra } = component as { text?: unknown; extra?: unknown };
    return flattenText(text) + flattenText(extra);
  }
  return "";
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export const pingServer: Ping = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`no status response within ${timeoutMs} ms`)), timeoutMs);

    // Settling twice is harmless: a promise ignores everything after the first.
    function fail(error: Error): void {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }

    socket.on("connect", () => socket.write(Buffer.concat([handshake(host, port), packet(0x00)])));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) return fail(new Error("status response too large"));
      try {
        const json = readStatusResponse(received);
        if (json === null) return;
        const result = parseStatus(json);
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("connection closed before a status response")));
  });

export interface Monitor {
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
  statuses(): ServerStatus[];
}

// Pings every server on an interval and keeps the latest results in memory, so page
// views never open a socket and a slow server cannot delay a response.
export function createMonitor(
  servers: MinecraftServerConfig[],
  { ping = pingServer, intervalMs = 30_000, timeoutMs = 3_000, now = () => new Date() } = {},
): Monitor {
  let statuses: ServerStatus[] = servers.map((server) => ({ server, state: "unknown", checkedAt: null, result: null }));
  let timer: NodeJS.Timeout | undefined;

  async function check(previous: ServerStatus): Promise<ServerStatus> {
    const { server } = previous;
    try {
      const result = await ping(server.host, server.port, timeoutMs);
      if (previous.state !== "online") console.log(`minecraft "${server.name}": online`);
      return { server, state: "online", checkedAt: now(), result };
    } catch (error) {
      if (previous.state !== "offline") console.log(`minecraft "${server.name}": offline (${(error as Error).message})`);
      return { server, state: "offline", checkedAt: now(), result: null };
    }
  }

  async function refresh(): Promise<void> {
    statuses = await Promise.all(statuses.map(check));
  }

  return {
    refresh,
    start() {
      if (timer || servers.length === 0) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    statuses: () => statuses,
  };
}
