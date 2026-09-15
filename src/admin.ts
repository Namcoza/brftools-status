import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { AccessError, type AccessVerifier } from "./access.ts";
import {
  ago,
  breadcrumbs,
  detailList,
  escapeHtml,
  FAVICON_SVG,
  glyph,
  logBlock,
  page,
  statusPill,
  type Crumb,
  type NavLinks,
  type Tone,
} from "./html.ts";
import type { MediaServiceConfig, MediaStatus } from "./media.ts";
import type { MinecraftServerConfig, ServerStatus } from "./minecraft.ts";

// The private Minecraft admin menu, served only on the admin hostname and only to requests that
// carry a valid Cloudflare Access token. It never touches Minecraft or Docker itself: an action is
// a small request file dropped in the inbox for the host's root-owned runner, which checks it
// against an allow-list, does the work, and writes progress to the state directory (mounted
// read-only here). See README, "Admin menu".

export const ACTIONS = {
  save: { label: "Save world", disruptive: false, whenRunning: true },
  restart: { label: "Restart", disruptive: true, whenRunning: true },
  stop: { label: "Stop", disruptive: true, whenRunning: true },
  start: { label: "Start", disruptive: false, whenRunning: false },
} as const;

export type Action = keyof typeof ACTIONS;

// What the runner does for each action, in order, so progress reads as steps rather than a state.
const STEP_PLANS: Record<Action, string[]> = {
  save: ["Saving the world"],
  restart: ["Warning players", "Saving the world", "Restarting the server", "Waiting for healthy"],
  stop: ["Warning players", "Saving the world", "Stopping the server"],
  start: ["Starting the server", "Waiting for healthy"],
};

// The runner's own step names, mapped onto the plan above.
const STEP_NAMES: Record<string, string> = {
  "warning players": "Warning players",
  saving: "Saving the world",
  restarting: "Restarting the server",
  stopping: "Stopping the server",
  starting: "Starting the server",
  "waiting for healthy": "Waiting for healthy",
};

const REQUEST_ID = /^[0-9a-f]{32}$/;
const REQUEST_FILE = /^[0-9a-f]{32}\.json$/;
// The runner gives up on a request after 45 minutes, so an older "running" result is abandoned.
const RUNNING_STALE_MS = 45 * 60_000;
// The host writes server state every 30 seconds.
const SNAPSHOT_STALE_MS = 2 * 60_000;

export interface ServerSnapshot {
  generatedAt: Date | null;
  exists: boolean;
  running: boolean;
  status: string;
  health: string;
  startedAt: Date | null;
  stoppedBy: string;
  stoppedAt: Date | null;
  log: string[];
}

export interface ActionResult {
  id: string;
  server: string;
  action: string;
  requestedBy: string;
  status: string;
  step: string;
  detail: string;
  updatedAt: Date | null;
}

export interface HistoryEntry {
  id: string;
  server: string;
  action: string;
  requestedBy: string;
  status: string;
  step: string;
  finishedAt: Date | null;
}

export function parseSnapshot(json: string): ServerSnapshot {
  const raw = record(JSON.parse(json));
  const stopped = record(raw.stopped);
  return {
    generatedAt: date(raw.generatedAt),
    exists: raw.exists === true,
    running: raw.running === true,
    status: text(raw.status),
    health: text(raw.health),
    startedAt: date(raw.startedAt),
    stoppedBy: text(stopped.stoppedBy),
    stoppedAt: date(stopped.stoppedAt),
    log: Array.isArray(raw.log) ? raw.log.filter((line): line is string => typeof line === "string") : [],
  };
}

export function parseResult(json: string): ActionResult {
  const raw = record(JSON.parse(json));
  return {
    id: text(raw.id),
    server: text(raw.server),
    action: text(raw.action),
    requestedBy: text(raw.requestedBy),
    status: text(raw.status),
    step: text(raw.step),
    detail: text(raw.detail),
    updatedAt: date(raw.updatedAt),
  };
}

// Newest first; lines that are not valid JSON are skipped.
export function parseHistory(jsonl: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = record(JSON.parse(line));
      entries.push({
        id: text(raw.id),
        server: text(raw.server),
        action: text(raw.action),
        requestedBy: text(raw.requestedBy),
        status: text(raw.status),
        step: text(raw.step),
        finishedAt: date(raw.finishedAt),
      });
    } catch {
      // Skip the line.
    }
  }
  return entries.reverse();
}

export interface AdminOptions {
  hostname: string;
  verifier: AccessVerifier;
  servers: MinecraftServerConfig[];
  minecraft: () => ServerStatus[];
  // The media services and their latest state. Their addresses are shown only here.
  mediaServices?: MediaServiceConfig[];
  media?: () => MediaStatus[];
  inboxDir: string;
  stateDir: string;
  // Header and footer links; statusUrl is the public status page.
  nav?: { statusUrl: string; gamesUrl: string; mapUrl: string };
  now?: () => Date;
}

export function createAdminHandler(options: AdminOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { hostname, verifier, servers, inboxDir, stateDir } = options;
  const mediaServices = options.mediaServices ?? [];
  const mediaStatuses = options.media ?? (() => []);
  const now = options.now ?? (() => new Date());
  const origin = `https://${hostname}`;
  const nav: NavLinks = {
    status: options.nav?.statusUrl || "/",
    games: options.nav?.gamesUrl ?? "",
    map: options.nav?.mapUrl ?? "",
  };
  const crumbRoot = (): Crumb[] => [{ label: "Status", href: nav.status }, { label: "Servers", href: "/" }];

  const snapshotOf = (id: string) => readParsed(join(stateDir, "servers", `${id}.json`), parseSnapshot);
  const resultOf = (requestId: string) => readParsed(join(stateDir, "results", `${requestId}.json`), parseResult);
  const statusOf = (id: string) => options.minecraft().find((status) => status.server.id === id);
  const history = async () => (await readParsed(join(stateDir, "history.jsonl"), parseHistory)) ?? [];

  // An action is in progress while a request waits in the inbox or a recent result is still running.
  async function inProgress(): Promise<string | null> {
    const queued = (await list(join(inboxDir, "new"))).find((name) => REQUEST_FILE.test(name));
    if (queued) return queued.slice(0, 32);
    const resultsDir = join(stateDir, "results");
    for (const name of await list(resultsDir)) {
      if (!REQUEST_FILE.test(name)) continue;
      const path = join(resultsDir, name);
      try {
        if (now().getTime() - (await stat(path)).mtimeMs > RUNNING_STALE_MS) continue;
      } catch {
        continue;
      }
      if ((await readParsed(path, parseResult))?.status === "running") return name.slice(0, 32);
    }
    return null;
  }

  // Written under tmp/ and renamed into new/, so the runner never sees a half-written request.
  async function submit(server: MinecraftServerConfig, action: Action, email: string): Promise<string> {
    const id = randomBytes(16).toString("hex");
    const request = { id, server: server.id, action, requestedBy: email, requestedAt: now().toISOString() };
    const tmp = join(inboxDir, "tmp", `${id}.json`);
    await writeFile(tmp, JSON.stringify(request), { mode: 0o600 });
    await rename(tmp, join(inboxDir, "new", `${id}.json`));
    return id;
  }

  // Form posts must come from the admin menu itself, not from another site the browser is on.
  function sameOrigin(req: IncomingMessage): boolean {
    const site = header(req, "sec-fetch-site");
    if (site) return site === "same-origin";
    return header(req, "origin") === origin;
  }

  function adminPage(title: string, body: string, refreshSeconds?: number): string {
    return page({ title: `${title} · Minecraft admin`, body, refreshSeconds, nav, faviconUrl: "/favicon.svg" });
  }

  async function overviewPage(email: string): Promise<string> {
    const [entries, current] = await Promise.all([history(), inProgress()]);
    const t = now();
    const cards = await Promise.all(
      servers.map(async (server) => {
        const snapshot = await snapshotOf(server.id);
        const state = stateOf(snapshot);
        const details: [string, string][] = [["Players", playersHtml(statusOf(server.id))]];
        if (snapshot && !snapshot.running && snapshot.stoppedBy) details.push(["Stopped by", stoppedHtml(snapshot, t)]);
        const last = entries.find((entry) => entry.server === server.id);
        if (last) {
          const when = last.finishedAt ? `, ${ago(last.finishedAt, t)} ago` : "";
          details.push(["Last action", `${escapeHtml(`${actionLabel(last.action)}: ${outcome(last.status, last.step)}`)}${when}`]);
        }
        return `<section class="card">
          <div class="card-head"><h3><a class="cover" href="/servers/${escapeHtml(server.id)}">${escapeHtml(server.name)}</a></h3>${statusPill(state.tone, state.label)}</div>
          ${detailList(details)}
        </section>`;
      }),
    );
    const body = `${breadcrumbs([{ label: "Status", href: nav.status }, { label: "Servers" }])}
      <h1>Minecraft admin</h1>
      <p class="meta">Signed in as ${escapeHtml(email)}.</p>
      ${current ? `<p>An action is in progress: <a href="/actions/${current}">view its progress</a>.</p>` : ""}
      <div class="cards">
        ${cards.join("\n        ")}
      </div>
      ${mediaServices.length ? `<div class="actions"><a class="btn" href="/media">Media services</a></div>` : ""}`;
    return adminPage("Servers", body, 30);
  }

  async function serverPage(server: MinecraftServerConfig, email: string): Promise<string> {
    const [snapshot, entries, current] = await Promise.all([snapshotOf(server.id), history(), inProgress()]);
    const status = statusOf(server.id);
    const state = stateOf(snapshot);
    const t = now();
    const id = escapeHtml(server.id);

    const details: [string, string][] = [["Players", playersHtml(status)]];
    if (status?.state === "online" && status.result?.version) details.push(["Version", escapeHtml(status.result.version)]);
    if (snapshot?.running && snapshot.startedAt) details.push(["Uptime", ago(snapshot.startedAt, t)]);
    if (snapshot && !snapshot.running && snapshot.stoppedBy) details.push(["Stopped by", stoppedHtml(snapshot, t)]);

    let actions: string;
    if (current) {
      actions = `<p>Another action is in progress: <a href="/actions/${current}">view its progress</a>.</p>`;
    } else if (!snapshot?.exists) {
      actions = `<p class="meta">Actions are unavailable until the host reports this server's state.</p>`;
    } else {
      const available = (Object.keys(ACTIONS) as Action[]).filter((action) => ACTIONS[action].whenRunning === snapshot.running);
      actions = `<div class="actions">${available
        .map((action, index) =>
          ACTIONS[action].disruptive
            ? `<a class="btn btn-danger" href="/servers/${id}/confirm?action=${action}">${ACTIONS[action].label}…</a>`
            : actionForm(server, action, ACTIONS[action].label, index === 0 ? "btn-primary" : ""),
        )
        .join("")}</div>`;
    }

    const rows = entries
      .filter((entry) => entry.server === server.id)
      .slice(0, 10)
      .map(
        (entry) =>
          `<tr><td>${entry.finishedAt ? `${ago(entry.finishedAt, t)} ago` : ""}</td><td>${escapeHtml(actionLabel(entry.action))}</td><td>${escapeHtml(outcome(entry.status, entry.step))}</td><td>${escapeHtml(entry.requestedBy)}</td></tr>`,
      );
    const table = rows.length
      ? `<table class="table"><thead><tr><th>When</th><th>Action</th><th>Result</th><th>By</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
      : `<p class="meta">No actions yet.</p>`;

    const stale =
      snapshot?.generatedAt && t.getTime() - snapshot.generatedAt.getTime() > SNAPSHOT_STALE_MS
        ? `<p class="meta">Server state last updated ${ago(snapshot.generatedAt, t)} ago; the host snapshot may have stopped.</p>`
        : "";

    const body = `${breadcrumbs([...crumbRoot(), { label: server.name }])}
      <h1>${escapeHtml(server.name)}</h1>
      <p>${statusPill(state.tone, state.label)}</p>
      ${detailList(details)}
      ${stale}
      <h2>Actions</h2>
      ${actions}
      <h2>Recent actions</h2>
      ${table}
      <h2>Recent log</h2>
      <p class="meta">Last 50 lines, with IP addresses removed.</p>
      ${snapshot?.log.length ? logBlock(snapshot.log) : `<p class="meta">No log available.</p>`}
      <p class="meta">Signed in as ${escapeHtml(email)}.</p>`;
    return adminPage(server.name, body, 30);
  }

  function confirmPage(server: MinecraftServerConfig, action: Action): string {
    const { label, disruptive } = ACTIONS[action];
    const status = statusOf(server.id);
    const online = status?.state === "online" && status.result ? status.result.playersOnline : 0;
    const names = status?.result?.playerNames ?? [];
    const who =
      online > 0
        ? `<p><strong>${online} ${online === 1 ? "player is" : "players are"} online</strong>${names.length ? ` (${names.map(escapeHtml).join(", ")})` : ""}. They are warned in chat at 60, 30 and 10 seconds first.</p>`
        : `<p>Nobody is online, so this happens straight away.</p>`;
    const what: Record<Action, string> = {
      save: "The world is saved. Nobody is disconnected.",
      restart: "The world is saved and the server restarts. It is usually back within two minutes.",
      stop: "The world is saved and the server stops. <strong>It stays stopped, even if the host reboots, until someone presses Start.</strong>",
      start: "The server starts. It is usually ready within two minutes.",
    };
    const id = escapeHtml(server.id);
    const body = `${breadcrumbs([...crumbRoot(), { label: server.name, href: `/servers/${server.id}` }, { label }])}
      <h1>${label} ${escapeHtml(server.name)}?</h1>
      ${disruptive ? who : ""}
      <p>${what[action]}</p>
      ${disruptive ? `<p class="meta">Player counts can be up to 30 seconds old; the host checks again before acting.</p>` : ""}
      <div class="actions">
        ${actionForm(server, action, `${label} now`, disruptive ? "btn-danger" : "btn-primary")}
        <a class="btn" href="/servers/${id}">Cancel</a>
      </div>`;
    return adminPage(`${label} ${server.name}?`, body);
  }

  async function progressPage(requestId: string): Promise<string> {
    const [result, queued] = await Promise.all([resultOf(requestId), exists(join(inboxDir, "new", `${requestId}.json`))]);
    const server = servers.find((candidate) => candidate.id === result?.server);
    const t = now();

    const finished = result !== null && result.status in FINISHED;
    const { label, tone } = !result
      ? { label: queued ? "Queued" : "Waiting for the host", tone: "warn" as Tone }
      : (FINISHED[result.status] ?? { label: "In progress", tone: "warn" as Tone });

    const action = result ? actionFrom(result.action) : null;
    const steps = action && result && result.status !== "rejected" ? stepList(action, result) : "";

    const details: [string, string][] = [];
    // With steps, the current step already carries the step name and its detail.
    if (!steps && result?.step) details.push(["Step", escapeHtml(capitalise(result.step))]);
    if (!steps && result?.detail && result.status !== "failed") details.push(["Detail", escapeHtml(result.detail)]);
    if (result?.requestedBy) details.push(["Requested by", escapeHtml(result.requestedBy)]);
    if (result?.updatedAt) details.push(["Updated", `${ago(result.updatedAt, t)} ago`]);
    const failure = result?.status === "failed" && result.detail ? `<h2>Recent log</h2>${logBlock(result.detail.split("\n"))}` : "";

    const title = result ? `${actionLabel(result.action)}: ${server?.name ?? result.server}` : "Action";
    const crumbs: Crumb[] = server
      ? [...crumbRoot(), { label: server.name, href: `/servers/${server.id}` }, { label: actionLabel(result?.action ?? "") }]
      : [...crumbRoot(), { label: "Action" }];

    const body = `${breadcrumbs(crumbs)}
      <h1>${escapeHtml(title)}</h1>
      <p>${statusPill(tone, label)}</p>
      ${steps}
      ${detailList(details)}
      ${finished ? "" : `<p class="meta">This page refreshes every 3 seconds.</p>`}
      ${failure}
      <div class="actions">${server ? `<a class="btn" href="/servers/${escapeHtml(server.id)}">Back to ${escapeHtml(server.name)}</a>` : `<a class="btn" href="/">All servers</a>`}</div>`;
    return adminPage(title, body, finished ? undefined : 3);
  }

  async function postAction(req: IncomingMessage, res: ServerResponse, server: MinecraftServerConfig, email: string) {
    const back = `<a class="btn" href="/servers/${escapeHtml(server.id)}">Back to ${escapeHtml(server.name)}</a>`;
    if (!sameOrigin(req)) {
      console.error(`admin: refused cross-site POST for ${server.id} (${JSON.stringify(email)})`);
      return sendHtml(res, 403, messagePage("Refused", "The request did not come from the admin menu itself.", "bad"));
    }
    const body = await readBody(req, 1024);
    if (body === null) return sendHtml(res, 413, messagePage("Too large", back, "bad"));
    const action = actionFrom(new URLSearchParams(body).get("action"));
    if (!action) return sendHtml(res, 400, messagePage("Unknown action", back, "bad"));

    const snapshot = await snapshotOf(server.id);
    if (!snapshot?.exists) {
      return sendHtml(res, 409, messagePage("Not possible right now", `The host has not reported this server's state. ${back}`, "warn"));
    }
    if (ACTIONS[action].whenRunning !== snapshot.running) {
      const why = snapshot.running ? "is already running" : "is not running";
      return sendHtml(res, 409, messagePage("Not possible right now", `${escapeHtml(server.name)} ${why}. ${back}`, "warn"));
    }
    const current = await inProgress();
    if (current) {
      return sendHtml(
        res,
        409,
        messagePage("Another action is in progress", `<a class="btn btn-primary" href="/actions/${current}">Watch progress</a>`, "warn"),
      );
    }

    const requestId = await submit(server, action, email);
    console.log(`admin: ${JSON.stringify(email)} requested ${action} on ${server.id} (${requestId})`);
    res.writeHead(303, { location: `/actions/${requestId}`, "cache-control": "no-store" });
    res.end();
  }

  // The only page that shows a media service's address: it is behind Access and the token check.
  function mediaPage(email: string): string {
    const statuses = mediaStatuses();
    const t = now();
    const cards = mediaServices.map((service) => {
      const status = statuses.find((candidate) => candidate.service.id === service.id);
      const state = mediaStateOf(status);
      const details: [string, string][] = [];
      if (status?.state === "up" && status.result?.version) details.push(["Version", escapeHtml(status.result.version)]);
      details.push(["Tailscale", `<a href="${escapeHtml(service.url)}">${escapeHtml(shortUrl(service.url))}</a>`]);
      if (service.lanUrl) {
        details.push(["Home network", `<a href="${escapeHtml(service.lanUrl)}">${escapeHtml(shortUrl(service.lanUrl))}</a>`]);
      }
      return `<section class="card">
          <div class="card-head"><h3><a class="cover" href="${escapeHtml(service.url)}">${escapeHtml(service.name)}</a></h3>${statusPill(state.tone, state.label)}</div>
          ${detailList(details)}
          <p class="meta">${status?.checkedAt ? `Checked ${ago(status.checkedAt, t)} ago` : "Not checked yet"}</p>
        </section>`;
    });
    const body = `${breadcrumbs([{ label: "Status", href: nav.status }, { label: "Media" }])}
      <h1>Media services</h1>
      <p class="meta">Signed in as ${escapeHtml(email)}. Tailscale links work anywhere with Tailscale on; home-network links only at home.</p>
      <div class="cards">
        ${cards.join("\n        ")}
      </div>
      <div class="actions"><a class="btn" href="/">Minecraft admin</a></div>`;
    return adminPage("Media services", body, 30);
  }

  function messagePage(title: string, html: string, tone: Tone = "bad"): string {
    const body = `${breadcrumbs(crumbRoot())}
      <p class="state ${tone}">${glyph(tone)}</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${html}</p>`;
    return adminPage(title, body);
  }

  return async (req, res) => {
    const url = new URL(req.url ?? "/", origin);

    if (req.method === "GET" && url.pathname === "/favicon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
      res.end(FAVICON_SVG);
      return;
    }

    let email: string;
    try {
      email = (await verifier.verify(header(req, "cf-access-jwt-assertion"))).email;
    } catch (error) {
      const reason = error instanceof AccessError ? error.message : `verification failed: ${(error as Error).message}`;
      console.error(`admin: refused ${req.method} ${JSON.stringify(req.url)}: ${reason}`);
      return sendHtml(res, 403, messagePage("Forbidden", "Sign in through Cloudflare Access to use the admin menu."));
    }

    const [section, name, sub, ...rest] = url.pathname.split("/").filter(Boolean);
    const server = section === "servers" ? servers.find((candidate) => candidate.id === name) : undefined;

    if (rest.length === 0) {
      if (req.method === "GET" && section === undefined) return sendHtml(res, 200, await overviewPage(email));
      if (req.method === "GET" && server && sub === undefined) return sendHtml(res, 200, await serverPage(server, email));
      if (req.method === "GET" && server && sub === "confirm") {
        const action = actionFrom(url.searchParams.get("action"));
        if (action) return sendHtml(res, 200, confirmPage(server, action));
      }
      if (req.method === "POST" && server && sub === "actions") return postAction(req, res, server, email);
      if (req.method === "GET" && section === "actions" && name && REQUEST_ID.test(name) && sub === undefined) {
        return sendHtml(res, 200, await progressPage(name));
      }
      if (req.method === "GET" && section === "media" && name === undefined && mediaServices.length > 0) {
        return sendHtml(res, 200, mediaPage(email));
      }
      // The id is a key into the configured services, never a URL: this cannot be made to
      // redirect anywhere else.
      if (req.method === "GET" && section === "open" && name && sub === undefined) {
        const service = mediaServices.find((candidate) => candidate.id === name);
        if (service) {
          console.log(`admin: ${JSON.stringify(email)} opened ${service.id}`);
          res.writeHead(302, { location: service.url, "cache-control": "no-store" });
          res.end();
          return;
        }
      }
    }
    return sendHtml(res, 404, messagePage("Not found", `<a class="btn" href="/">All servers</a>`));
  };

  // Steps read as a list: filled = done, outlined = current, dashed = still to come.
  function stepList(action: Action, result: ActionResult): string {
    const plan = STEP_PLANS[action];
    const currentLabel = STEP_NAMES[result.step] ?? "";
    const done = result.status === "done";
    const at = done ? plan.length : Math.max(0, plan.indexOf(currentLabel));
    const items = plan.map((label, index) => {
      const state =
        index < at
          ? { tone: "ok" as Tone, word: "Done" }
          : index > at
            ? { tone: "idle" as Tone, word: "Queued" }
            : result.status === "failed"
              ? { tone: "bad" as Tone, word: "Failed" }
              : { tone: "warn" as Tone, word: "In progress" };
      const note = index === at && !done && result.detail ? ` · ${escapeHtml(result.detail)}` : "";
      return `<li><span class="state ${state.tone}">${glyph(state.tone)}</span><span><span class="label">${escapeHtml(label)}</span><span class="meta">${state.word}${note}</span></span></li>`;
    });
    return `<ol class="steps">${items.join("")}</ol>`;
  }
}

const FINISHED: Record<string, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  rejected: { label: "Refused", tone: "bad" },
};

const OUTCOMES: Record<string, string> = { done: "Done", failed: "Failed", rejected: "Refused", running: "In progress" };

function mediaStateOf(status: MediaStatus | undefined): { label: string; tone: Tone } {
  if (!status || status.state === "unknown") return { label: "Checking…", tone: "idle" };
  if (status.state === "down") return { label: "Down", tone: "bad" };
  return status.result?.setupIncomplete ? { label: "Setup not complete", tone: "warn" } : { label: "Up", tone: "ok" };
}

// Host and port are what identify a service here; the scheme and path are noise.
function shortUrl(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? parsed.host : url;
}

function stateOf(snapshot: ServerSnapshot | null): { label: string; tone: Tone } {
  if (!snapshot) return { label: "No data from the host", tone: "bad" };
  if (!snapshot.exists) return { label: "Container missing", tone: "bad" };
  if (!snapshot.running) return { label: "Stopped", tone: "bad" };
  if (snapshot.health === "starting") return { label: "Starting", tone: "warn" };
  if (snapshot.health === "unhealthy") return { label: "Running, unhealthy", tone: "bad" };
  return { label: "Running", tone: "ok" };
}

function playersHtml(status: ServerStatus | undefined): string {
  if (!status || status.state === "unknown") return "Checking…";
  if (status.state !== "online" || !status.result) return "Not reachable";
  const { playersOnline, playersMax, playerNames } = status.result;
  const count = `${playersOnline} / ${playersMax}`;
  if (playersOnline === 0 || playerNames.length === 0) return count;
  const more = playersOnline - playerNames.length;
  return `${count} — ${playerNames.map(escapeHtml).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function stoppedHtml(snapshot: ServerSnapshot, now: Date): string {
  return `${escapeHtml(snapshot.stoppedBy)}${snapshot.stoppedAt ? `, ${ago(snapshot.stoppedAt, now)} ago` : ""}`;
}

function actionForm(server: MinecraftServerConfig, action: Action, text: string, variant: string): string {
  const cls = variant ? `btn ${variant}` : "btn";
  return `<form method="post" action="/servers/${escapeHtml(server.id)}/actions"><input type="hidden" name="action" value="${action}" /><button class="${cls}" type="submit">${escapeHtml(text)}</button></form>`;
}

function actionFrom(value: string | null): Action | null {
  return value !== null && Object.hasOwn(ACTIONS, value) ? (value as Action) : null;
}

function actionLabel(action: string): string {
  const known = actionFrom(action);
  return known ? ACTIONS[known].label : action || "Unknown";
}

function outcome(status: string, step: string): string {
  const label = OUTCOMES[status] ?? status;
  return step ? `${label} (${step})` : label;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // No scripts, no framing (so the buttons cannot be clickjacked), forms only to this origin.
    // img-src 'self' is only for this app's own favicon.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "same-origin",
  });
  res.end(html);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readParsed<T>(path: string, parse: (text: string) => T): Promise<T | null> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Docker reports "0001-01-01T00:00:00Z" for times that never happened.
function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 2000 ? null : parsed;
}
