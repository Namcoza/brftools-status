// The public home page: a tabbed redesign (Overview, Minecraft, Media, Remote access,
// Releases) in the "Industry" visual language from a design handoff. Adapted to this app's
// real constraints, which the handoff's HTML prototype does not have to honour:
//
// - No JavaScript, no web fonts, no external stylesheets or images (see html.ts, "System
//   fonts, inline CSS and inline SVG only"). Tabs are plain routes, not client-side state;
//   there is no copy-to-clipboard button or live "seconds ago" ticker.
// - The public page must never show a media service's address or port (PRODUCT.md,
//   acceptance criterion 10). Every "Open" link goes through the admin hostname's
//   `/open/<id>` redirect, exactly as the existing media cards already do.
// - This is a public repository: real hardware facts, IP addresses and paths cannot be
//   committed (AGENTS.md, "This repository is public"). The Overview's hardware grid,
//   "Needs attention" list and the Remote tab's reach table are optional, read from one
//   JSON blob in production config (HOME_FACTS_JSON — see config.ts) and simply do not
//   render when it is unset.

import type { Config, DriveUsage, HardwareFact, HomeFacts, HomeIssue, NavConfig, ReachRow } from "./config.ts";
import { ago, escapeHtml, glyph, MARK, type Tone } from "./html.ts";
import type { MediaStatus } from "./media.ts";
import type { ServerStatus } from "./minecraft.ts";
import { GROUP_LABELS, serviceMeta, type ServiceGroup } from "./service-meta.ts";
import type { TailscaleView } from "./tailscale.ts";

export type Section = "overview" | "minecraft" | "media" | "remote" | "releases";
export type MediaFilter = "all" | ServiceGroup;
export type MediaView = "cards" | "table";

export const SECTIONS: { id: Section; path: string; label: string }[] = [
  { id: "overview", path: "/", label: "Overview" },
  { id: "minecraft", path: "/minecraft", label: "Minecraft" },
  { id: "media", path: "/media", label: "Media" },
  { id: "remote", path: "/remote", label: "Remote access" },
  { id: "releases", path: "/releases", label: "Releases" },
];

export interface ReleaseRow {
  version: string;
  startedAt: Date;
}

export interface HomeData {
  section: Section;
  currentVersion: string;
  minecraft: ServerStatus[];
  media: MediaStatus[];
  tailscale: TailscaleView | null;
  releases: ReleaseRow[];
  facts: HomeFacts;
  adminUrl: string;
  nav: NavConfig;
  now: Date;
  mediaFilter: MediaFilter;
  mediaView: MediaView;
}

const COMMIT_URL = "https://github.com/Namcoza/brftools-status/commit/";
const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "play", label: "Players" },
  { id: "lib", label: "Librarians" },
  { id: "fetch", label: "Sources & downloaders" },
];

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f2f2f3; --text: #1d1f20; --line: rgba(29, 31, 32, 0.16);
    --accent: #5980a6; --accent-100: #eef6ff; --accent-700: #416180; --accent-800: #2c455d;
    --n-200: #e7e7ea; --n-400: #b7b7ba; --n-500: #98989b; --n-600: #7a7a7d; --n-700: #5d5d60;
    --ok: #1c7a46; --bad: #b02a22; --idle: #5d5d60;
    --font-heading: system-ui, sans-serif; --font-body: system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15181b; --text: #e6e8ea; --line: rgba(230, 232, 234, 0.18);
      --accent: #94bce3; --accent-100: #1d2d3d; --accent-700: #b5d9fd; --accent-800: #d6ebff;
      --n-200: #2a2f34; --n-400: #6b6f73; --n-500: #83878b; --n-600: #9a9ea3; --n-700: #b6b9bd;
      --ok: #58c98a; --bad: #f2857c; --idle: #9a9ea3;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 400 15px/1.55 var(--font-body); }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
  a { color: var(--accent-700); }
  a:hover { color: var(--accent-800); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    background: color-mix(in srgb, var(--accent) 10%, transparent); padding: 1px 5px; overflow-wrap: anywhere; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  h1, h2, h3 { font-family: var(--font-heading); font-weight: 600; letter-spacing: -0.01em; margin: 0; }

  header.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
  header.top .wrap { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 14px 0; color: var(--text); text-decoration: none; }
  .brand svg { color: var(--accent); }
  .brand b { font-family: var(--font-heading); font-weight: 600; font-size: 21px; }
  .brand small { font-size: 12px; color: var(--n-700); padding-left: 10px; border-left: 1px solid var(--line); }
  nav.tabs { display: flex; gap: 2px; margin-left: auto; overflow-x: auto; }
  nav.tabs a { display: flex; align-items: center; gap: 7px; padding: 0 12px; min-height: 48px;
    font-size: 14px; color: var(--n-700); text-decoration: none; border-bottom: 2px solid transparent; white-space: nowrap; }
  nav.tabs a:hover { color: var(--text); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  nav.tabs a.active { color: var(--text); font-weight: 500; border-bottom-color: var(--accent); }
  nav.tabs .num { font-size: 10px; letter-spacing: 0.08em; color: var(--n-500); }
  nav.tabs a.active .num { color: var(--accent-700); }

  main { padding: 0 0 64px; }
  .kicker { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent-700); margin: 0 0 8px; }

  .sq { display: inline-block; width: 8px; height: 8px; flex: none; }
  .sq.ok { background: var(--ok); } .sq.bad { background: var(--bad); } .sq.idle { background: var(--idle); }
  .state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; }
  .state.ok { color: var(--ok); } .state.bad { color: var(--bad); } .state.idle { color: var(--idle); }

  .blueprint { position: relative; border: 1px solid var(--line); }
  .corner { position: absolute; width: 11px; height: 11px; opacity: 0.55; pointer-events: none; }
  .corner::before, .corner::after { content: ""; position: absolute; background: var(--text); }
  .corner::before { width: 100%; height: 1px; top: 5px; left: 0; }
  .corner::after { width: 1px; height: 100%; left: 5px; top: 0; }
  .corner.tl { top: -6px; left: -6px; } .corner.tr { top: -6px; right: -6px; }
  .corner.bl { bottom: -6px; left: -6px; } .corner.br { bottom: -6px; right: -6px; }

  .hero { position: relative; padding: 40px 0 32px; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 24px; align-items: end; }
  .hero h1 { font-size: clamp(48px, 9vw, 96px); line-height: 0.9; letter-spacing: -0.02em; }
  .hero p { font-size: 17px; max-width: 46ch; margin: 14px 0 0; }
  .hero-status { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
  .hero-status .state { font-family: var(--font-heading); font-weight: 600; font-size: 24px; gap: 10px; }
  .hero-status .sq { width: 10px; height: 10px; }
  .hero-meta { font-size: 13px; color: var(--n-700); }

  .plate { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1px; background: var(--line); }
  .plate-cell { background: var(--bg); padding: 16px 18px; display: grid; gap: 4px; }
  .plate-cell .label { font-size: 10px; letter-spacing: 0.1em; color: var(--n-600); }
  .plate-cell .num { font-family: var(--font-heading); font-weight: 600; font-size: 40px; line-height: 1; }
  .plate-cell .num .of { color: var(--n-500); font-size: 26px; }
  .plate-cell .cap { font-size: 12px; color: var(--n-700); }
  .bar { height: 4px; background: var(--n-200); margin-top: 4px; }
  .bar > span { display: block; height: 100%; background: var(--accent); }

  h2.section-h { font-size: 26px; margin: 48px 0 16px; }
  .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 18px; }
  .ocard { padding: 18px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; color: inherit; }
  .ocard:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .ocard .title { font-family: var(--font-heading); font-weight: 600; font-size: 21px; }
  .ocard .body { font-size: 14px; margin: 0; }
  .ocard .link { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--accent-700); margin-top: auto; }

  .media-mini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line);
    border: 1px solid var(--line); }
  .media-mini-cell { background: var(--bg); padding: 8px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px; min-width: 0; }
  .media-mini-cell .mono { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
  .media-mini-cell .mono .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .media-mini-cell .mono .ver { font-size: 11px; color: var(--n-600); }

  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 32px; margin-top: 48px; }
  .issue-row { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .issue-row:first-child { border-top: 1px solid var(--line); }
  .issue-row .title { font-weight: 500; }
  .issue-row .body { font-size: 14px; color: var(--n-700); margin: 2px 0 0; }
  .hw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .hw-cell { background: var(--bg); padding: 12px 14px; display: grid; gap: 2px; }
  .hw-cell .label { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--n-600); }
  .hw-cell .value { font-weight: 500; }
  .hw-cell .detail { font-size: 12px; color: var(--n-700); }

  .kv { display: grid; grid-template-columns: auto 1fr; gap: 8px 20px; font-size: 14px; }
  .kv dt { color: var(--n-700); margin: 0; } .kv dd { margin: 0; }

  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border: 1px solid var(--line);
    background: transparent; color: var(--text); font: inherit; text-decoration: none; cursor: pointer; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  .btn-secondary { justify-content: space-between; width: 100%; }

  .mc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 20px; }
  .mc-panel { padding: 24px; display: grid; gap: 20px; }
  .mc-players .label { font-size: 10px; letter-spacing: 0.1em; color: var(--n-600); }
  .mc-players .count { font-family: var(--font-heading); font-weight: 600; font-size: 72px; line-height: 0.9; letter-spacing: -0.02em; }
  .mc-players .count .of { color: var(--n-400); font-size: 40px; }

  .filters { display: flex; border: 1px solid var(--line); flex-wrap: wrap; }
  .filters a { padding: 7px 12px; font-size: 13px; color: var(--text); text-decoration: none; }
  .filters a:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .filters a.active { background: var(--accent); color: var(--bg); }
  .filters a.active:hover { background: var(--accent); }
  .filters .n { opacity: 0.75; }

  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 18px; }
  .mcard { padding: 18px; display: flex; flex-direction: column; gap: 10px; }
  .mcard .name { font-family: var(--font-heading); font-weight: 600; font-size: 22px; }
  .mcard .role { font-size: 13px; color: var(--n-700); }
  .mcard .desc { font-size: 14px; margin: 0; flex: 1; }
  .mcard .note { font-size: 12px; color: var(--accent-800); background: var(--accent-100); padding: 5px 9px; }

  table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.data th { text-align: left; font-weight: 600; color: var(--n-700); border-bottom: 1px solid var(--line); padding: 8px 12px 8px 0; }
  table.data td { border-bottom: 1px solid var(--line); padding: 8px 12px 8px 0; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); }
  .table-wrap table.data { min-width: 640px; }
  .table-wrap table.data th:first-child, .table-wrap table.data td:first-child { padding-left: 12px; }

  .timeline { position: relative; padding-left: 26px; }
  .timeline .rail { position: absolute; left: 5px; top: 6px; bottom: 6px; width: 1px; background: var(--line); }
  .release-row { position: relative; padding: 0 0 24px; }
  .release-row .marker { position: absolute; left: -26px; top: 5px; width: 11px; height: 11px; border: 1px solid var(--accent); background: var(--bg); }
  .release-row .head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .release-row .title { font-family: var(--font-heading); font-weight: 600; font-size: 20px; }
  .release-row .body { font-size: 14px; margin: 4px 0 0; color: var(--n-700); }

  footer.bottom { border-top: 1px solid var(--line); }
  footer.bottom .wrap { padding: 16px 24px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    font-size: 12px; color: var(--n-700); }

  @media (max-width: 480px) {
    .hero h1 { font-size: 56px; }
    .two-col, .hw-grid { grid-template-columns: 1fr; }
  }
`;

export function renderHome(data: HomeData): string {
  const body =
    data.section === "overview"
      ? renderOverview(data)
      : data.section === "minecraft"
        ? renderMinecraft(data)
        : data.section === "media"
          ? renderMedia(data)
          : data.section === "remote"
            ? renderRemote(data)
            : renderReleases(data);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="60" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>brftools · ${escapeHtml(SECTIONS.find((s) => s.id === data.section)?.label ?? "")}</title>
    <style>${STYLES}    </style>
  </head>
  <body>
    <header class="top">
      <div class="wrap">
        <a class="brand" href="/">${MARK}<b>brftools</b><small>P410 · thinkpadserver</small></a>
        <nav class="tabs">
          ${SECTIONS.map(
            (s, i) =>
              `<a href="${s.path}"${s.id === data.section ? ' class="active"' : ""}><span class="num">0${i}</span>${escapeHtml(s.label)}</a>`,
          ).join("\n          ")}
        </nav>
      </div>
    </header>
    <main class="wrap">
${body}
    </main>
    <footer class="bottom">
      <div class="wrap">
        <span>brftools · run at home</span>
        <span>Running ${versionHtml(data.currentVersion)}</span>
      </div>
    </footer>
  </body>
</html>
`;
}

// --- Overview -----------------------------------------------------------

function renderOverview(data: HomeData): string {
  const { minecraft, media, tailscale, facts, now } = data;

  const mcOnline = minecraft.filter((s) => s.state === "online");
  const mediaUp = media.filter((s) => s.state === "up");
  const totalUp = mcOnline.length + mediaUp.length;
  const totalServices = minecraft.length + media.length;
  const allUp = totalServices > 0 && totalUp === totalServices;
  const downCount = totalServices - totalUp;

  const playersOnline = minecraft.reduce((sum, s) => sum + (s.result?.playersOnline ?? 0), 0);
  const playersMax = minecraft.reduce((sum, s) => sum + (s.result?.playersMax ?? 0), 0);

  const peers = tailscale?.snapshot?.peers ?? [];
  const peersOnline = peers.filter((p) => p.online).length;

  const heroTone: Tone = totalServices === 0 ? "idle" : allUp ? "ok" : "bad";
  const heroLabel = totalServices === 0 ? "No monitors configured" : allUp ? "All systems up" : `${downCount} service${downCount === 1 ? "" : "s"} down`;

  const plateCells: string[] = [];
  if (totalServices > 0) {
    plateCells.push(statCell("01 · SERVICES UP", totalUp, totalServices, `Minecraft + ${media.length} media service${media.length === 1 ? "" : "s"}`));
  }
  if (minecraft.length > 0) {
    plateCells.push(statCell("02 · PLAYERS ONLINE", playersOnline, playersMax, minecraft.map((s) => s.server.name).join(", ")));
  }
  if (tailscale) {
    plateCells.push(statCell("03 · TAILNET", peersOnline, peers.length, `Devices online${tailscale.snapshot?.relay ? ` · relay ${tailscale.snapshot.relay.toUpperCase()}` : ""}`));
  }
  if (facts.drive) {
    const pct = Math.min(100, Math.round((facts.drive.usedTb / facts.drive.totalTb) * 100));
    plateCells.push(`<div class="plate-cell">
        <span class="label">04 · MEDIA DRIVE</span>
        <span class="num">${facts.drive.usedTb}<span class="of"> / ${facts.drive.totalTb} TB</span></span>
        <div class="bar"><span style="width:${pct}%"></span></div>
      </div>`);
  }
  const plate = plateCells.length ? `<div class="plate blueprint">${cornerMarks()}${plateCells.join("\n      ")}</div>` : "";

  const cards: string[] = [];
  if (minecraft.length > 0) {
    const online = mcOnline.length;
    const names = minecraft.map((s) => s.server.name).join(", ");
    cards.push(
      overviewCard({
        href: "/minecraft",
        kicker: "01 · Minecraft",
        title: minecraft.length === 1 ? minecraft[0]!.server.name : "Minecraft",
        tone: online === minecraft.length ? "ok" : online > 0 ? "ok" : "bad",
        stateLabel: `${online} / ${minecraft.length} online`,
        body: `${playersOnline} of ${playersMax} players across ${names}.`,
        link: "Server, map and backups",
      }),
    );
  }
  if (media.length > 0) {
    cards.push(mediaOverviewCard(media, mediaUp.length));
  }
  if (tailscale) {
    cards.push(
      overviewCard({
        href: "/remote",
        kicker: "03 · Remote access",
        title: "Tailnet",
        tone: tailscale.state === "connected" ? "ok" : tailscale.state === "degraded" ? "ok" : "bad",
        stateLabel: tailscale.state === "connected" ? "Connected" : tailscale.state === "degraded" ? "Connected, with warnings" : "Not connected",
        body: `${peers.length} device${peers.length === 1 ? "" : "s"}, ${peersOnline} online.`,
        link: "Devices and reach",
      }),
    );
  }
  cards.push(
    overviewCard({
      href: "/releases",
      kicker: "04 · Releases",
      title: "Status app",
      tone: "idle",
      stateCode: data.currentVersion,
      body: "Deploy timer checks every five minutes.",
      link: "Release history",
    }),
  );

  const sections = cards.length
    ? `<h2 class="section-h">Sections</h2>
      <div class="cards-grid">
        ${cards.join("\n        ")}
      </div>`
    : "";

  const issues = facts.issues.length
    ? `<div>
        <h2 class="section-h" style="margin-top:0;">Needs attention</h2>
        ${facts.issues.map(issueRow).join("\n        ")}
      </div>`
    : "";
  const hardware = facts.hardware.length
    ? `<div>
        <h2 class="section-h" style="margin-top:0;">Hardware</h2>
        <div class="hw-grid">${facts.hardware.map(hardwareCell).join("")}</div>
      </div>`
    : "";
  const bottom = issues || hardware ? `<div class="two-col">${issues}${hardware}</div>` : "";

  return `      <div class="hero">
        <div>
          <div class="kicker">Home server · run at home</div>
          <h1>brftools</h1>
          <p>The family Minecraft world, the media library, remote access and the app that watches over them.</p>
        </div>
        <div class="hero-status">
          <span class="state ${heroTone}"><span class="sq ${heroTone}"></span>${escapeHtml(heroLabel)}</span>
          <span class="hero-meta">Refreshed every 60 s</span>
        </div>
      </div>
      ${plate}
      ${sections}
      ${bottom}`;
}

function statCell(label: string, value: number, max: number, caption: string): string {
  return `<div class="plate-cell">
        <span class="label">${escapeHtml(label)}</span>
        <span class="num">${value}<span class="of"> / ${max}</span></span>
        <span class="cap">${escapeHtml(caption)}</span>
      </div>`;
}

function overviewCard(opts: {
  href: string;
  kicker: string;
  title: string;
  tone: Tone;
  stateLabel?: string;
  stateCode?: string;
  body: string;
  link: string;
}): string {
  const state = opts.stateCode
    ? `<code>${escapeHtml(opts.stateCode.length === 40 ? opts.stateCode.slice(0, 7) : opts.stateCode)}</code>`
    : `<span class="state ${opts.tone}"><span class="sq ${opts.tone}"></span>${escapeHtml(opts.stateLabel ?? "")}</span>`;
  return `<a class="ocard blueprint" href="${escapeHtml(opts.href)}">${cornerMarks()}
          <div class="kicker" style="margin:0;">${escapeHtml(opts.kicker)}</div>
          <div class="row"><span class="title">${escapeHtml(opts.title)}</span>${state}</div>
          <p class="body">${escapeHtml(opts.body)}</p>
          <span class="link">${escapeHtml(opts.link)} →</span>
        </a>`;
}

function mediaOverviewCard(media: MediaStatus[], upCount: number): string {
  const rows = media
    .map(
      ({ service, state, result }) => `<div class="media-mini-cell">
            <span class="mono"><span class="name">${escapeHtml(service.name)}</span><span class="ver">${escapeHtml(result?.version || "—")}</span></span>
            <span class="sq ${state === "up" ? "ok" : state === "down" ? "bad" : "idle"}" style="margin-left:auto;"></span>
          </div>`,
    )
    .join("");
  return `<a class="ocard blueprint" href="/media" style="grid-row:span 2;">${cornerMarks()}
          <div class="kicker" style="margin:0;">02 · Media</div>
          <div class="row"><span class="title">Media stack</span><span style="font-size:12px;color:var(--n-700);">${upCount} / ${media.length} up</span></div>
          <div class="media-mini">${rows}</div>
          <span class="link">Players, librarians and downloaders →</span>
        </a>`;
}

function issueRow(issue: HomeIssue): string {
  const tone: Tone = issue.tag === "fix" ? "bad" : "idle";
  const label = issue.tag === "fix" ? "Fix" : issue.tag === "waiting" ? "Waiting" : "Note";
  return `<div class="issue-row">
          <span class="state ${tone}"><span class="sq ${tone}"></span>${label}</span>
          <div><div class="title">${escapeHtml(issue.title)}</div><div class="body">${escapeHtml(issue.body)}</div></div>
        </div>`;
}

function hardwareCell(fact: HardwareFact): string {
  return `<div class="hw-cell">
      <span class="label">${escapeHtml(fact.label)}</span>
      <span class="value">${escapeHtml(fact.value)}</span>
      ${fact.detail ? `<span class="detail">${escapeHtml(fact.detail)}</span>` : ""}
    </div>`;
}

function cornerMarks(): string {
  return `<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>`;
}

// --- Minecraft ------------------------------------------------------------

function renderMinecraft(data: HomeData): string {
  const { minecraft, now } = data;
  if (minecraft.length === 0) {
    return `      <div style="padding:44px 0 28px;"><div class="kicker">01 · Minecraft</div><h1 style="font-size:40px;">No servers configured</h1></div>`;
  }
  const panels = minecraft.map((status) => {
    const { server, state, checkedAt, result } = status;
    const tone: Tone = state === "online" ? "ok" : state === "offline" ? "bad" : "idle";
    const label = { unknown: "Checking…", online: "Online", offline: "Offline" }[state];
    const checked = checkedAt ? `Checked ${ago(checkedAt, now)} ago` : "Not checked yet";
    const players = state === "online" && result ? `${result.playersOnline}<span class="of"> / ${result.playersMax}</span>` : `—<span class="of"> / —</span>`;
    const kv: [string, string][] = [];
    if (state === "online" && result?.version) kv.push(["Version", escapeHtml(result.version)]);
    if (server.join) kv.push(["Join", escapeHtml(server.join)]);
    const map = server.mapUrl
      ? `<a class="btn btn-primary blueprint" href="${escapeHtml(server.mapUrl)}" style="justify-self:start;">${cornerMarks()}Open the map</a>`
      : "";
    return `<div class="mc-panel blueprint">${cornerMarks()}
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="state ${tone}"><span class="sq ${tone}" style="width:10px;height:10px;"></span>${label}</span>
          <span style="font-size:12px;color:var(--n-700);">${checked}</span>
        </div>
        <div class="mc-players">
          <div class="label">${escapeHtml(server.name.toUpperCase())} · PLAYERS</div>
          <div class="count">${players}</div>
        </div>
        ${kv.length ? `<dl class="kv" style="border-top:1px solid var(--line);padding-top:16px;">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
        ${map}
      </div>`;
  });

  return `      <div style="padding:44px 0 28px;"><div class="kicker">01 · Minecraft</div><h1 style="font-size:40px;">${minecraft.length === 1 ? escapeHtml(minecraft[0]!.server.name) : "Minecraft servers"}</h1></div>
      <div class="mc-grid">${panels.join("\n      ")}</div>`;
}

// --- Media ------------------------------------------------------------

function renderMedia(data: HomeData): string {
  const { media, adminUrl, mediaFilter, mediaView, now } = data;
  if (media.length === 0) {
    return `      <div style="padding:44px 0 28px;"><div class="kicker">02 · Media</div><h1 style="font-size:40px;">No media services configured</h1></div>`;
  }

  const enriched = media.map((status) => ({ status, meta: serviceMeta(status.service.id) }));
  const shown = mediaFilter === "all" ? enriched : enriched.filter((e) => e.meta.group === mediaFilter);
  const upCount = media.filter((s) => s.state === "up").length;
  const checked = media.some((s) => s.checkedAt) ? `Checked ${ago(new Date(Math.max(...media.filter((s) => s.checkedAt).map((s) => s.checkedAt!.getTime()))), now)} ago` : "Not checked yet";

  const filters = MEDIA_FILTERS.map((f) => {
    const count = f.id === "all" ? media.length : enriched.filter((e) => e.meta.group === f.id).length;
    const href = `/media${f.id === "all" ? "" : `?group=${f.id}`}${mediaView === "table" ? `${f.id === "all" ? "?" : "&"}view=table` : ""}`;
    return `<a href="${href}"${f.id === mediaFilter ? ' class="active"' : ""}>${escapeHtml(f.label)} <span class="n">${count}</span></a>`;
  }).join("");

  const content =
    mediaView === "table"
      ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Service</th><th>Group</th><th>Version</th><th>Reach</th><th>State</th></tr></thead>
          <tbody>${shown.map(mediaTableRow(adminUrl)).join("")}</tbody>
        </table></div>`
      : `<div class="media-grid">${shown.map(mediaCard(adminUrl)).join("\n        ")}</div>`;

  const otherView = mediaView === "table" ? "cards" : "table";
  const groupQuery = mediaFilter === "all" ? "" : `group=${mediaFilter}`;
  const viewQuery = otherView === "table" ? "view=table" : "";
  const toggleHref = `/media?${[groupQuery, viewQuery].filter(Boolean).join("&")}`;

  return `      <div style="padding:44px 0 28px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;">
        <div><div class="kicker">02 · Media</div><h1 style="font-size:40px;">Media stack</h1><p style="margin:8px 0 0;font-size:15px;color:var(--n-700);">${upCount} of ${media.length} up · ${checked}</p></div>
        <div class="filters">${filters}</div>
      </div>
      <p style="margin:0 0 16px;font-size:13px;"><a href="${toggleHref}">Switch to ${otherView} view →</a></p>
      ${content}`;
}

function mediaCard(adminUrl: string) {
  return ({ status, meta }: { status: MediaStatus; meta: ReturnType<typeof serviceMeta> }): string => {
    const { service, state, result } = status;
    const tone: Tone = state === "up" ? "ok" : state === "down" ? "bad" : "idle";
    const label = state === "unknown" ? "Checking…" : state === "down" ? "Down" : result?.setupIncomplete ? "Setup not complete" : "Up";
    const openHref = adminUrl ? `${adminUrl}/open/${service.id}` : "";
    return `<div class="mcard blueprint">${cornerMarks()}
          <div class="row"><span class="kicker" style="margin:0;">${escapeHtml(GROUP_LABELS[meta.group])}</span><span class="state ${tone}"><span class="sq ${tone}"></span>${label}</span></div>
          <div><div class="name">${escapeHtml(service.name)}</div>${meta.role ? `<div class="role">${escapeHtml(meta.role)}</div>` : ""}</div>
          ${meta.description ? `<p class="desc">${escapeHtml(meta.description)}</p>` : ""}
          <dl class="kv" style="border-top:1px solid var(--line);padding-top:12px;font-size:13px;">
            <dt>Version</dt><dd>${escapeHtml(result?.version || "—")}</dd>
          </dl>
          ${openHref ? `<a class="btn btn-secondary" href="${escapeHtml(openHref)}">Open ↗</a>` : ""}
        </div>`;
  };
}

function mediaTableRow(adminUrl: string) {
  return ({ status, meta }: { status: MediaStatus; meta: ReturnType<typeof serviceMeta> }): string => {
    const { service, state, result } = status;
    const tone: Tone = state === "up" ? "ok" : state === "down" ? "bad" : "idle";
    const label = state === "unknown" ? "Checking…" : state === "down" ? "Down" : result?.setupIncomplete ? "Setup" : "Up";
    const openHref = adminUrl ? `${adminUrl}/open/${service.id}` : "";
    return `<tr>
              <td><strong style="font-weight:500;">${escapeHtml(service.name)}</strong>${meta.role ? `<div style="font-size:12px;color:var(--n-700);">${escapeHtml(meta.role)}</div>` : ""}</td>
              <td>${escapeHtml(GROUP_LABELS[meta.group])}</td>
              <td>${escapeHtml(result?.version || "—")}</td>
              <td>${openHref ? `<a href="${escapeHtml(openHref)}">Open ↗</a>` : "—"}</td>
              <td><span class="state ${tone}"><span class="sq ${tone}"></span>${label}</span></td>
            </tr>`;
  };
}

// --- Remote access ------------------------------------------------------------

function renderRemote(data: HomeData): string {
  const { tailscale, facts, now } = data;
  if (!tailscale) {
    return `      <div style="padding:44px 0 28px;"><div class="kicker">03 · Remote access</div><h1 style="font-size:40px;">Not configured</h1></div>`;
  }
  const peers = tailscale.snapshot?.peers ?? [];
  const online = peers.filter((p) => p.online).length;
  const tone: Tone = tailscale.state === "connected" ? "ok" : tailscale.state === "degraded" ? "ok" : "bad";
  const label = tailscale.state === "connected" ? "Connected" : tailscale.state === "degraded" ? "Connected, with warnings" : tailscale.state === "stale" ? "No recent update" : "Down";
  const updated = tailscale.snapshot ? `${ago(tailscale.snapshot.generatedAt, now)} ago` : "No data";

  const reach = facts.reach.length
    ? `<h2 class="section-h">Who can reach what</h2>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Service</th><th>Home network</th><th>Tailnet</th><th>Anywhere</th><th>Notes</th></tr></thead>
        <tbody>${facts.reach.map(reachRow).join("")}</tbody>
      </table></div>`
    : "";

  return `      <div style="padding:44px 0 28px;"><div class="kicker">03 · Remote access</div><h1 style="font-size:40px;">Remote access</h1></div>
      <div class="plate blueprint">${cornerMarks()}
        <div class="plate-cell"><span class="label">THIS SERVER</span><span class="state ${tone}" style="font-family:var(--font-heading);font-weight:600;font-size:26px;"><span class="sq ${tone}" style="width:10px;height:10px;"></span>${label}</span></div>
        ${tailscale.snapshot?.relay ? `<div class="plate-cell"><span class="label">RELAY</span><span class="num" style="font-size:26px;">${escapeHtml(tailscale.snapshot.relay.toUpperCase())}</span></div>` : ""}
        <div class="plate-cell"><span class="label">DEVICES</span><span class="num" style="font-size:26px;">${online}<span class="of"> of ${peers.length} online</span></span></div>
        <div class="plate-cell"><span class="label">UPDATED</span><span class="num" style="font-size:26px;">${escapeHtml(updated)}</span></div>
      </div>
      ${reach}`;
}

function reachRow(row: ReachRow): string {
  return `<tr>
          <td style="font-weight:500;">${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.home)}</td><td>${escapeHtml(row.tail)}</td>
          <td><span style="font-weight:500;color:${row.anyOk ? "var(--ok)" : "var(--n-700)"};">${escapeHtml(row.any)}</span></td>
          <td style="font-size:13px;color:var(--n-700);">${escapeHtml(row.note)}</td>
        </tr>`;
}

// --- Releases ------------------------------------------------------------

function renderReleases(data: HomeData): string {
  const { releases, currentVersion } = data;
  const rows = releases.length
    ? releases
        .map((r, i) => {
          const isCurrent = r.version === currentVersion;
          return `<div class="release-row">
          <span class="marker"></span>
          <div class="head">${versionHtml(r.version)}<span class="title">${isCurrent ? "Running now" : "Started"}</span></div>
          <p class="body">${r.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC${i === 0 ? "" : ""}</p>
        </div>`;
        })
        .join("\n      ")
    : `<p>No releases recorded yet.</p>`;

  return `      <div style="padding:44px 0 28px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;">
        <div><div class="kicker">04 · Releases</div><h1 style="font-size:40px;">Release history</h1><p style="margin:8px 0 0;font-size:15px;">Each row is one start of the app; a rollback appears as an older version starting again.</p></div>
        <div class="blueprint" style="padding:12px 18px;">${cornerMarks()}<div class="label" style="font-size:10px;letter-spacing:0.1em;color:var(--n-600);">RUNNING</div><div style="font-family:ui-monospace,Menlo,monospace;font-size:22px;color:var(--accent-700);">${versionHtml(currentVersion)}</div></div>
      </div>
      <div class="timeline"><div class="rail"></div>${rows}</div>`;
}

function versionHtml(version: string): string {
  const shortened = /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
  const code = `<code>${escapeHtml(shortened)}</code>`;
  return /^[0-9a-f]{40}$/.test(version) ? `<a href="${COMMIT_URL}${version}">${code}</a>` : code;
}

export function parseSection(pathname: string): Section | null {
  const found = SECTIONS.find((s) => s.path === pathname);
  return found?.id ?? null;
}

export function homeFactsFromConfig(config: Config): HomeFacts {
  return config.homeFacts;
}
