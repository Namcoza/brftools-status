// Shared page shell and helpers for the public status page and the private admin menu.

const STYLES = `
      :root { color-scheme: light dark; }
      body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 0 auto; padding: 4rem 1.25rem; line-height: 1.5; }
      h1 { margin: 0 0 0.25rem; }
      h2 { margin: 2rem 0 0.25rem; font-size: 1.25rem; }
      table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; font-size: 0.9rem; }
      th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
      tr.current td { font-weight: 600; }
      code { font-size: 0.85em; word-break: break-all; }
      a { color: inherit; }
      .servers { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); margin-top: 1rem; }
      .server { position: relative; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 0.5rem; padding: 0.75rem 1rem; }
      .server h3 { margin: 0; font-size: 1rem; }
      .card-link { text-decoration: none; }
      .card-link::after { content: ""; position: absolute; inset: 0; border-radius: 0.5rem; }
      .server:has(.card-link):hover { border-color: color-mix(in srgb, currentColor 45%, transparent); }
      .server dd a { position: relative; z-index: 1; }
      .state { font-size: 0.85rem; font-weight: 600; }
      .state.online::before, .state.warning::before, .state.offline::before { content: "● "; }
      .state.online::before { color: #2e9e55; }
      .state.warning::before { color: #d99a1e; }
      .state.offline::before { color: #d9534f; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0.5rem 0; font-size: 0.9rem; }
      dt { opacity: 0.7; }
      dd { margin: 0; overflow-wrap: anywhere; }
      .devices { list-style: none; padding: 0; margin: 0.5rem 0; font-size: 0.9rem; }
      .devices span { opacity: 0.7; }
      .checked { margin: 0; font-size: 0.8rem; opacity: 0.7; }
      .note { font-size: 0.85rem; opacity: 0.7; }
      .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.75rem 0; }
      .actions form { margin: 0; }
      button, a.button { display: inline-block; font: inherit; font-size: 0.9rem; padding: 0.35rem 0.9rem; border-radius: 0.4rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: transparent; color: inherit; cursor: pointer; text-decoration: none; }
      button.danger, a.button.danger { border-color: #d9534f; color: #d9534f; }
      pre.log { font-size: 0.75rem; line-height: 1.4; overflow-x: auto; padding: 0.75rem; border-radius: 0.5rem; background: color-mix(in srgb, currentColor 6%, transparent); }
`;

export function page({ title, body, refreshSeconds }: { title: string; body: string; refreshSeconds?: number }): string {
  const refresh = refreshSeconds ? `\n    <meta http-equiv="refresh" content="${refreshSeconds}" />` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />${refresh}
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}    </style>
  </head>
  <body>
    ${body}
  </body>
</html>
`;
}

// Values are HTML already: callers escape anything that came from outside.
export function detailList(details: [string, string][]): string {
  return details.length ? `<dl>${details.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>` : "";
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
