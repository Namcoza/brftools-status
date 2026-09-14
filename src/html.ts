// Shared page shell, tokens and components for the public status page and the private admin
// menu, from the brftools design canvas ("Homelab Dashboard Design", 14 Sep 2026).
//
// System fonts, inline CSS and inline SVG only: the admin menu's Content-Security-Policy allows
// no scripts, web fonts or external stylesheets. Square corners, one hairline border weight, no
// shadows, and no animation — every page reloads itself on a timer, and a reload must be
// invisible. State always reads as a word, a shape and a colour together.

export type Tone = "ok" | "warn" | "bad" | "idle";

export interface NavLinks {
  // Absolute on the admin hostname, "/" on the status page itself.
  status: string;
  games: string;
  map: string;
}

export interface Crumb {
  label: string;
  href?: string;
}

// The mark: a trace crossing a three-line bus — the platform as one crossing point.
export const MARK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 8h8M14 8h8M2 12h8M14 12h8M2 16h8M14 16h8" /><path d="M12 2.5v19" /></svg>`;

// Reversed mark in a filled square, so the tab icon holds in either browser theme.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="brftools"><rect width="32" height="32" fill="#1d2d3d" /><g fill="none" stroke="#e6e8ea" stroke-width="2.4"><path d="M5 11h7M20 11h7M5 16h7M20 16h7M5 21h7M20 21h7" /><path d="M16 6v20" /></g></svg>
`;

const GLYPHS: Record<Tone, string> = {
  ok: `<rect width="10" height="10" fill="currentColor" />`,
  warn: `<path d="M5 0l5 10H0z" fill="currentColor" />`,
  bad: `<rect x=".7" y=".7" width="8.6" height="8.6" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M1.6 1.6l6.8 6.8" stroke="currentColor" stroke-width="1.4" />`,
  idle: `<rect x=".7" y=".7" width="8.6" height="8.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 2" />`,
};

const STYLES = `
      :root {
        color-scheme: light dark;
        --bg: #f2f2f3; --surface: #e7e7ea; --text: #1d1f20; --muted: #5d5d60;
        --accent: #5980a6; --accent-ink: #416180; --on-accent: #f2f2f3;
        --line: rgba(29, 31, 32, 0.16);
        --ok: #1c7a46; --warn: #8a5a00; --bad: #b02a22; --idle: #5d5d60;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #15181b; --surface: #20252a; --text: #e6e8ea; --muted: #9a9ea3;
          --accent: #94bce3; --accent-ink: #b5d9fd; --on-accent: #15181b;
          --line: rgba(230, 232, 234, 0.18);
          --ok: #58c98a; --warn: #e2b155; --bad: #f2857c; --idle: #9a9ea3;
        }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text);
        font: 400 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .page { max-width: 44rem; margin: 0 auto; padding: 0 16px 40px; }
      a { color: var(--accent-ink); }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.025em; margin: 24px 0 4px; }
      h2 { font-size: 19px; font-weight: 600; margin: 40px 0 12px; }
      h3 { font-size: 15px; font-weight: 600; margin: 0; }
      p { margin: 0 0 12px; }
      .meta { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
      code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }

      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px;
        padding: 16px 0; border-bottom: 1px solid var(--line); }
      .brand { display: inline-flex; align-items: center; gap: 8px; color: var(--text);
        font-weight: 600; text-decoration: none; }
      .brand svg { color: var(--accent); }
      .crumbs { font-size: 13px; color: var(--muted); padding: 8px 0; border-bottom: 1px solid var(--line); }
      .crumbs a { color: var(--muted); }
      .crumbs .here { color: var(--text); }
      .crumbs .sep { padding: 0 6px; }

      .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 40px;
        padding: 0 16px; border: 1px solid var(--line); border-radius: 0; background: transparent;
        color: var(--text); font: inherit; text-decoration: none; cursor: pointer; }
      .btn:hover { border-color: var(--accent); color: var(--accent-ink); }
      .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
      .btn-primary:hover { color: var(--on-accent); }
      .btn-danger { border-color: var(--bad); color: var(--bad); }
      .btn-small { min-height: 32px; padding: 0 12px; font-size: 13px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
      .actions form { margin: 0; }

      .cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
      .card { position: relative; border: 1px solid var(--line); padding: 12px 16px; }
      .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .cover { color: var(--text); text-decoration: none; }
      .cover::after { content: ""; position: absolute; inset: 0; }
      .card:hover:has(.cover) { border-color: var(--accent); }
      .card dd a, .card .above { position: relative; z-index: 1; }

      .state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
      .state.ok { color: var(--ok); }
      .state.warn { color: var(--warn); }
      .state.bad { color: var(--bad); }
      .state.idle { color: var(--idle); }

      .details { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 8px 0 0; }
      .details dt { color: var(--muted); }
      .details dd { margin: 0; overflow-wrap: anywhere; }

      .table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
      .table th { text-align: left; font-weight: 600; color: var(--muted);
        border-bottom: 1px solid var(--line); padding: 8px 8px 8px 0; }
      .table td { border-bottom: 1px solid var(--line); padding: 8px 8px 8px 0; }
      .table tr.current td { font-weight: 600; }

      .devices { list-style: none; margin: 8px 0 0; padding: 0; }
      .devices li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0;
        border-bottom: 1px solid var(--line); }
      .devices li:last-child { border-bottom: 0; }
      .devices .who { color: var(--muted); font-size: 13px; }
      details > summary { cursor: pointer; font-size: 13px; color: var(--muted); }

      .steps { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 12px; }
      .steps li { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: start; }
      .steps .label { display: block; font-weight: 600; }
      .steps .meta { display: block; margin: 0; }

      /* One dark block in both themes, so a log always looks like a log. */
      .log { background: #15181b; color: #e6e8ea; border: 1px solid var(--line); padding: 12px 16px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5;
        overflow-x: auto; white-space: pre; }

      .footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px;
        border-top: 1px solid var(--line); margin-top: 40px; padding: 16px 0;
        font-size: 13px; color: var(--muted); }
      .footer nav { display: flex; gap: 16px; }
      .footer a { color: var(--muted); }

      @media (max-width: 480px) {
        h1 { font-size: 24px; }
        .cards { grid-template-columns: 1fr; }
        /* Action buttons go full width for the thumb; the header's Status button does not. */
        .actions > .btn, .actions form { width: 100%; }
        .actions form .btn { width: 100%; }
      }
`;

export interface PageOptions {
  title: string;
  body: string;
  refreshSeconds?: number;
  // Omit to render a bare page (used by nothing yet; every surface carries the header).
  nav?: NavLinks;
  faviconUrl?: string;
}

export function page({ title, body, refreshSeconds, nav, faviconUrl }: PageOptions): string {
  const refresh = refreshSeconds ? `\n    <meta http-equiv="refresh" content="${refreshSeconds}" />` : "";
  const icon = faviconUrl ? `\n    <link rel="icon" href="${escapeHtml(faviconUrl)}" type="image/svg+xml" />` : "";
  const statusUrl = nav ? escapeHtml(nav.status || "/") : "";
  // One anchor: the Status button is on every surface, including the deepest admin page.
  const header = nav
    ? `<header class="topbar">
        <a class="brand" href="${statusUrl}">${MARK}<span>brftools</span></a>
        <a class="btn btn-small" href="${statusUrl}">Status</a>
      </header>`
    : "";
  const footerLinks = nav
    ? [
        `<a href="${statusUrl}">Status</a>`,
        nav.games ? `<a href="${escapeHtml(nav.games)}">Games</a>` : "",
        nav.map ? `<a href="${escapeHtml(nav.map)}">Map</a>` : "",
      ]
        .filter(Boolean)
        .join("")
    : "";
  const footer = nav
    ? `<footer class="footer">
        <span>brftools · run at home</span>
        <nav>${footerLinks}</nav>
      </footer>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />${refresh}${icon}
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}    </style>
  </head>
  <body>
    <div class="page">
      ${header}
      ${body}
      ${footer}
    </div>
  </body>
</html>
`;
}

// Depth lives here, never in the header: Status / Servers / Server A.
export function breadcrumbs(crumbs: Crumb[]): string {
  const parts = crumbs.map((crumb) =>
    crumb.href ? `<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>` : `<span class="here">${escapeHtml(crumb.label)}</span>`,
  );
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.join('<span class="sep">/</span>')}</nav>`;
}

// Filled square = good, triangle = warning, crossed square = bad, dashed square = waiting.
export function glyph(tone: Tone): string {
  return `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">${GLYPHS[tone]}</svg>`;
}

export function statusPill(tone: Tone, label: string): string {
  return `<span class="state ${tone}">${glyph(tone)}${escapeHtml(label)}</span>`;
}

// Values are HTML already: callers escape anything that came from outside.
export function detailList(details: [string, string][]): string {
  return details.length
    ? `<dl class="details">${details.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>`
    : "";
}

export function logBlock(lines: string[]): string {
  return `<pre class="log">${escapeHtml(lines.join("\n"))}</pre>`;
}

export function ago(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
