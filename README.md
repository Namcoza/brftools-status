# brftools-status

Status page for the brftools P410 deploy pilot. Each time a version of the app starts, it records the version and start time in PostgreSQL and lists them on its home page. Above that, it shows whether each configured Minecraft server is up and how many players are online. See [`PRODUCT.md`](PRODUCT.md) for purpose and acceptance criteria.

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
src/                 config.ts, db.ts (pool, migrations, queries), minecraft.ts (status ping), app.ts, server.ts
migrations/          numbered SQL migrations, applied in order at startup
tests/               node:test tests
Dockerfile           production image
compose.yml          production runtime declaration
.env.example         variable names only; never values
.gitleaks.toml       secret-scanning rules
.github/workflows/   ci.yml (required checks), deploy.yml (publish image)
```

## Hosting profile

**P410 Docker.** See [`docs/deployment-profiles.md`](docs/deployment-profiles.md), Profile B.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string, including credentials | required |
| `PORT` | Port the server listens on | `3000` |
| `APP_VERSION` | Version recorded and reported; the image sets it to the commit SHA | `dev` |
| `MC_n_PING` | Minecraft server `host:port` to ping, as reachable from the container. `n` is 1–4; a server is shown only when this is set | none |
| `MC_n_NAME` | Name shown for that server when it is offline or not yet checked (its MOTD is shown when online) | required with `MC_n_PING` |
| `MC_n_JOIN` | Free text shown as the address to join | none |
| `MC_n_MAP_URL` | `http`/`https` link to that server's web map | none |

Real values never go in the repository. In production, `.env` is rendered from 1Password at deploy time.

### Minecraft section

The app pings each configured server every 30 seconds with the Minecraft Server List Ping — the status query a game client uses, which needs no credential — with a 3-second timeout, and keeps the latest result in memory. Page views never open a connection. The page shows name, online/offline, version and `online / max` players; **player names are never shown**. A server being offline never affects `/healthz`, so a game server restart cannot roll this app back. Offline/online changes are logged.

## Persistent data

| Data | Where | Backup | Restore |
|---|---|---|---|
| Release history | `status` database on the P410's shared PostgreSQL, owned by the `status` role | Included in the nightly `pg_dumpall` | Restore the dump into a clean instance; the table is also safe to lose — it is history only |

Schema changes are numbered files in `migrations/`, applied once each at startup inside a transaction. Each file carries its own recovery note. Rolling back an image does not reverse a migration.

## Deploy, verify, roll back

- **Deploy:** merge a passing pull request to `main`. CI passes, then `deploy.yml` publishes `ghcr.io/namcoza/brftools-status:<full sha>` and moves `:main` to it. The P410 picks up the new `:main` digest within a few minutes.
- **Verify:** `GET /healthz` returns `{"status":"ok","version":"<commit sha>","database":"ok"}` (plus a `minecraft` list of names and states when servers are configured), and the home page shows that version in the release history.
- **Roll back:** on the P410, run the deploy script with `--rollback` to return to the previous image digest. A release that fails its health check is rolled back automatically.

## Repository settings

Ruleset `protect-main` on the default branch: pull request required; status checks `test`, `gitleaks` and `docker` required; force pushes and deletion blocked. Secret scanning and push protection on.
