import { readFile } from "node:fs/promises";

// This container is not given the host's tailscaled socket: that socket allows changes,
// not just reads. Instead a timer on the host writes a trimmed summary to a file that is
// mounted read-only here. This module reads that file and judges it.

export interface TailscalePeer {
  name: string;
  os: string;
  online: boolean;
  lastSeen: Date | null;
}

export interface TailscaleSnapshot {
  generatedAt: Date;
  backendState: string;
  error: string;
  online: boolean;
  health: string[];
  relay: string;
  peers: TailscalePeer[];
}

export interface TailscaleView {
  state: "connected" | "degraded" | "down" | "stale" | "missing";
  snapshot: TailscaleSnapshot | null;
}

// The host timer writes every minute; allow for a couple of missed runs before calling it stale.
export const STALE_AFTER_MS = 3 * 60_000;

export function parseSnapshot(json: string): TailscaleSnapshot {
  const raw = (JSON.parse(json) ?? {}) as Record<string, unknown>;
  const generatedAt = new Date(text(raw.generatedAt));
  if (Number.isNaN(generatedAt.getTime())) throw new Error("snapshot has no valid generatedAt");
  return {
    generatedAt,
    backendState: text(raw.backendState),
    error: text(raw.error),
    online: raw.online === true,
    health: Array.isArray(raw.health) ? raw.health.filter((item): item is string => typeof item === "string") : [],
    relay: text(raw.relay),
    peers: Array.isArray(raw.peers) ? raw.peers.map(toPeer) : [],
  };
}

function toPeer(value: unknown): TailscalePeer {
  const peer = (value ?? {}) as Record<string, unknown>;
  const lastSeen = typeof peer.lastSeen === "string" ? new Date(peer.lastSeen) : null;
  return {
    name: text(peer.name),
    os: text(peer.os),
    online: peer.online === true,
    lastSeen: lastSeen && !Number.isNaN(lastSeen.getTime()) ? lastSeen : null,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function classify(snapshot: TailscaleSnapshot, now: Date): TailscaleView["state"] {
  if (now.getTime() - snapshot.generatedAt.getTime() > STALE_AFTER_MS) return "stale";
  if (snapshot.backendState !== "Running" || !snapshot.online) return "down";
  return snapshot.health.length > 0 ? "degraded" : "connected";
}

// A missing or unreadable file is a state to show, not an error: the page must still render.
export async function readTailscale(path: string, now: Date = new Date()): Promise<TailscaleView> {
  try {
    const snapshot = parseSnapshot(await readFile(path, "utf8"));
    return { state: classify(snapshot, now), snapshot };
  } catch {
    return { state: "missing", snapshot: null };
  }
}
