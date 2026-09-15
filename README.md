# brftools-status

Status page for the brftools P410 deploy pilot. Each time a version of the app starts, it records the version and start time in PostgreSQL and lists them on its home page. Above that, it shows whether each configured Minecraft server is up and how many players are online, and the host's Tailscale connection. A private admin menu on a separate hostname lets the owner save, restart, stop and start the Minecraft servers. See [`PRODUCT.md`](PRODUCT.md) for purpose and acceptance criteria.

**branch = work · pull request = validation · main = live**

---

## Requirements

| Tool | Version | Install (Mac) |
|---|---|---|
| Node.js | 24 LTS (`.nvmrc`) | `brew install node@24 && brew link --overwrite node@24` — `node@24` is not linked onto the PATH by default |
| PostgreSQL | 17 | `brew install postgresql@17` — for local development and tests |
| gitleaks | 8.x | `brew install gitleaks` |

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Run locally, reloading on change | `npm run dev` → http://localhost:3000 (needs `DATABASE_URL` in `.env`) |
| Type check | `npm run check` |
| Test | `npm test` — set `TEST_DATABASE_URL` to run the database tests; they are skipped otherwise |
| Build | `npm run build` → `dist/` |
| Run the build | `npm start` |
| Scan for secrets | `npm run secrets` |

The database tests drop and recreate their tables, so `TEST_DATABASE_URL` must name a database whose name contains `test`. A throwaway local database:

```bash
PG=/opt/homebrew/opt/postgresql@17/bin
export LC_ALL=en_US.UTF-8   # Homebrew's postgres refuses to start without a valid locale
$PG/initdb -D /tmp/status-pg -U postgres --auth=trust
$PG/pg_ctl -D /tmp/status-pg -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" -l /tmp/status-pg.log -w start
$PG/createdb -h 127.0.0.1 -p 55432 -U postgres status_test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/status_test npm test
$PG/pg_ctl -D /tmp/status-pg stop
```

TCP only (`unix_socket_directories=`) avoids macOS's 103-byte limit on socket paths when the data directory is deep.

## Layout

```
AGENTS.md            rules for AI-assisted changes (CLAUDE.md points here)
PRODUCT.md           purpose, users and acceptance criteria
docs/                intake checklist, deployment profiles, decisions
src/                 config.ts, db.ts (pool, migrations, queries), minecraft.ts (status ping), tailscale.ts (host summary),
                     access.ts (Access token check), admin.ts (admin menu), html.ts, app.ts, server.ts
migrations/          numbered SQL migrations, applied in order at startup
tests/               node:test tests
Dockerfile           production image
compose.yml          production runtime declaration
.env.example         variable names only; never values
.gitleaks.toml       secret-scanning rules
.github/workflows/   ci.yml (required checks), deploy.yml (publish image)
```

## Design

Pages follow the brftools design canvas: one mark, one set of light/dark tokens, and one navigation model — a `Status` button in the header of every surface that returns to the public status page, breadcrumbs for depth, and a footer that links the surfaces to each other. `src/html.ts` holds the shell, tokens and components; nothing else defines colour or spacing.

Constraints that shape it: system fonts, inline CSS and inline SVG only (the admin menu allows no scripts, web fonts or external stylesheets), square corners, one hairline border weight, no shadows, and no animation — every page reloads itself on a timer, so a reload has to be invisible. State always reads as a word, a shape and a colour together, and the status colours meet WCAG AA in both themes.

## Hosting profile

**P410 Docker.** See [`docs/deployment-profiles.md`](docs/deployment-profiles.md), Profile B.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string, including credentials | required |
| `PORT` | Port the server listens on | `3000` |
| `APP_VERSION` | Version recorded and reported; the image sets it to the commit SHA | `dev` |
| `MC_n_PING` | Minecraft server `host:port` to ping, as reachable from the container. `n` is 1–4; a server is shown only when this is set | none |
| `MC_n_ID` | Slug for that server in the admin menu and the host runner (lower-case letters, digits, hyphens). Required for every server when the admin menu is on | none |
| `MC_n_NAME` | Name shown for that server when it is offline or not yet checked (its MOTD is shown when online) | required with `MC_n_PING` |
| `MC_n_JOIN` | Free text shown as the address to join | none |
| `MC_n_MAP_URL` | `http`/`https` link to that server's web map | none |
| `TAILSCALE_STATUS_FILE` | Absolute path, inside the container, of the Tailscale summary written by the host. Unset hides the section | none |
| `MEDIA_n_CHECK` | Credential-free health URL for a media service, reachable from the container. `n` is 1–8; a service exists only when this is set | none |
| `MEDIA_n_ID` | Slug used by the admin menu's `/open/<id>` | required with `MEDIA_n_CHECK` |
| `MEDIA_n_NAME` | Name shown publicly | required with `MEDIA_n_CHECK` |
| `MEDIA_n_KIND` | `plex`, `arr`, `sabnzbd` or `audiobookshelf` — chooses how the response is read | required with `MEDIA_n_CHECK` |
| `MEDIA_n_URL` | Where `/open/<id>` sends a signed-in browser | required with `MEDIA_n_CHECK` |
| `MEDIA_n_LAN_URL` | Home-network address, listed on the admin menu's media page | none |
| `ADMIN_HOSTNAME` | Hostname the private admin menu is served on. The admin menu is on only when this and the next four are all set | none |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain, e.g. `<team>.cloudflareaccess.com`; its signing keys verify admin requests | none |
| `ACCESS_AUD` | Audience tag of the Access application protecting `ADMIN_HOSTNAME` | none |
| `MC_ACTIONS_INBOX_DIR` | Absolute path, inside the container, of the runner's inbox (writable) | none |
| `MC_ACTIONS_STATE_DIR` | Absolute path, inside the container, of the runner's state (read-only) | none |
| `PUBLIC_STATUS_URL` | Absolute URL of the public status page, used by the header's Status button and the footer. Falls back to `/` | none |
| `PUBLIC_GAMES_URL` | Absolute URL of the games hub, for the footer. Omitted when unset | none |
| `PUBLIC_MAP_URL` | Absolute URL of the world map, for the footer. Omitted when unset | none |

Real values never go in the repository. In production, `.env` is rendered from 1Password at deploy time.

### Minecraft section

The app pings each configured server every 30 seconds with the Minecraft Server List Ping — the status query a game client uses, which needs no credential — with a 3-second timeout, and keeps the latest result in memory. Page views never open a connection. The page shows name, online/offline, version and `online / max` players; **player names are never shown**. A server being offline never affects `/healthz`, so a game server restart cannot roll this app back. Offline/online changes are logged.

### Tailscale section

Shows whether the host is connected to its tailnet, for troubleshooting remote access. The container is **not** given the host's `tailscaled` socket, which allows changes as well as reads. Instead, a timer on the host runs `tailscale status --json` every minute and writes a trimmed summary to `status.json` in a directory that `compose.yml` mounts read-only at `/run/tailscale-status`. The summary holds backend state, health warnings, the home relay, and each other device's name, OS and online state — no IP addresses, keys or tailnet names. The file is read on each page view:

| Shown | When |
|---|---|
| Connected | Snapshot under 3 minutes old, backend `Running`, connected to Tailscale, no health warnings |
| Connected, with warnings | As above, with health warnings listed |
| Needs login, Stopped, Not responding… | Backend not running normally, or not connected to Tailscale |
| No recent update | Snapshot older than 3 minutes — the host timer has stopped |
| No data | File missing or unreadable |

**Device names are shown on this public page** by the owner's decision. As with Minecraft, Tailscale state never affects `/healthz`. The host script and timer are not part of this repository.

### Media section

Shows whether each configured media service is up: name, state and — where the service gives it away without a credential — its version. Audiobookshelf also reports whether its setup is finished.

- **No credentials, ever.** Each `MEDIA_n_CHECK` endpoint answers unauthenticated: Plex `/identity`, Sonarr and Radarr `/ping`, SABnzbd `/api?mode=version&output=json`, Audiobookshelf `/status`. The app holds no API key and can only read. Sonarr and Radarr therefore show up or down only; their version needs a key.
- **No addresses on the public page.** Each card is a link to `https://<ADMIN_HOSTNAME>/open/<id>`, so Cloudflare Access sits between the click and the address. The admin menu's `/media` page is the only place a service's address is shown, and `/open/<id>` redirects to `MEDIA_n_URL`. The id is a key into the configured list, never a URL, so it cannot be turned into an open redirect.
- **Polling, not per-request:** every 30 seconds with a 3-second timeout, held in memory. Any non-200, timeout or unreadable body is "Down". Audiobookshelf's `ConfigPath` and `MetadataPath` are discarded at parse time.
- A service being down never affects `/healthz`.

### Admin menu

A private menu for the Minecraft servers: who is online by name, each server's state and recent log, recent actions, and buttons to **save**, **restart**, **stop** and **start**. Clicking a server card on the public page opens it.

- **Private, and checked by the app.** Admin pages are served only for requests whose `Host` is `ADMIN_HOSTNAME`, which sits behind a Cloudflare Access application. The app also verifies the `Cf-Access-Jwt-Assertion` token on every admin request itself: the RS256 signature against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, the audience `ACCESS_AUD`, the issuer and the expiry. Without a valid token, every admin route returns `403`, however the request arrived. The public hostname never serves admin routes.
- **No Minecraft, Docker or RCON access in the app.** An action is a small JSON request (`id`, `server`, `action`, `requestedBy`, `requestedAt`) written to `MC_ACTIONS_INBOX_DIR/tmp/` and then renamed into `new/`. A root-owned runner on the host, not part of this repository, then:
  - checks the request against an allow-list
  - before a restart or stop, warns players in chat at 60, 30 and 10 seconds and saves the world
  - does the action and writes its progress to `MC_ACTIONS_STATE_DIR/results/<id>.json`

  The runner also writes each server's container state and recent log (with IP addresses removed) to `servers/<id>.json`, and an audit trail to `history.jsonl`. The state directory is mounted read-only.
- **Actions:**
  - *Save world* and *Start* run straight away.
  - *Restart* and *Stop* go through a confirmation page that names who is online.
  - One action runs at a time; the runner also rate-limits and re-checks the server's state.
  - **Stop is sticky**: a stopped server stays stopped, even across host reboots, until someone presses Start.
- **Browser protections:** form posts must be same-origin — `Sec-Fetch-Site: same-origin`, or a matching `Origin` when the browser sends no `Sec-Fetch-Site`. Admin pages send `no-store`, and a Content-Security-Policy that allows no scripts and no framing.

## Persistent data

| Data | Where | Backup | Restore |
|---|---|---|---|
| Release history | `status` database on the P410's shared PostgreSQL, owned by the `status` role | Included in the nightly `pg_dumpall` | Restore the dump into a clean instance; the table is also safe to lose — it is history only |

Schema changes are numbered files in `migrations/`, applied once each at startup inside a transaction. Each file carries its own recovery note. Rolling back an image does not reverse a migration.

## Deploy, verify, roll back

- **Deploy:** merge a passing pull request to `main`. CI passes, then `deploy.yml` publishes `ghcr.io/namcoza/brftools-status:<full sha>` and moves `:main` to it. The P410 picks up the new `:main` digest within a few minutes.
- **Verify:** `GET /healthz` returns `{"status":"ok","version":"<commit sha>","database":"ok"}` (plus a `minecraft` list of names and states, and a `tailscale` state, when those are configured), and the home page shows that version in the release history.
- **Roll back:** on the P410, run the deploy script with `--rollback` to return to the previous image digest. A release that fails its health check is rolled back automatically.

## Repository settings

Ruleset `protect-main` on the default branch: pull request required; status checks `test`, `gitleaks` and `docker` required; force pushes and deletion blocked. Secret scanning and push protection on.
