# Product

## Purpose

A small status page. It shows the release history of this app: every time a new version starts, it records the version (commit SHA) and start time. It also shows whether the family's Minecraft servers are up and how many players are online, and whether the host is connected to its Tailscale network, for troubleshooting remote access. A private admin menu lets the owner save, restart, stop and start the Minecraft servers from a browser, without SSH. It is the pilot for the P410 Docker deployment path — its main value is proving that path, not the page itself.

## Users

- **Public page:** Brendon, the family, and anyone who visits the hostname, from any network.
- **Admin menu:** Brendon only, after a Cloudflare Access login.

## Hosting profile

P410 Docker. It needs a server process and PostgreSQL. It reads files written by the host and writes admin requests for the host to act on.

## Access

- **Public hostname:** public.
  - Start times and commit SHAs, which are already public in this repository.
  - For each Minecraft server: name, state, version, player counts, a join address and a map link.
  - The host's Tailscale state, relay, health warnings, and the names, OS and online state of the other devices on the tailnet.
  - For each media service: its name, whether it is up, and its version where that is free. **No address, port or link target.**
  - Minecraft player names are never shown. Tailscale device names are shown by the owner's decision; IP addresses and tailnet names are not.
- **Admin hostname:** private. It sits behind a Cloudflare Access application, and the app verifies the Access token on every request, so a request that reaches the app any other way gets nothing. It shows player names and a recent server log with IP addresses removed.
- Which addresses and hostnames are used is production configuration, not part of this repository.

## Data

- **Release history:** in its own `status` database on the P410's PostgreSQL. No personal data. Replaceable: losing it loses only history.
- **Minecraft status:** held in memory only.
- **Tailscale summary, admin server state and action history:** host-written files, read on each view.
- **Admin requests:** small files handed to the host and deleted by it.
- None of these is stored by the app.

## Acceptance criteria

1. Merging a passing pull request to `main` publishes an image tagged with the full commit SHA, and the P410 runs it without manual steps.
2. `GET /healthz` returns `200` with the running version only when the database is reachable, and `503` otherwise. Minecraft, Tailscale and admin state never change the status code.
3. `GET /` lists releases newest first, and a rollback shows up as an older version starting again.
4. A release whose health check fails is replaced by the previous version automatically.
5. The previous release can be restored within 15 minutes.
6. `GET /` shows each configured Minecraft server as online or offline, with version and `online / max` players when online, refreshed at least every minute. It never lists player names.
7. `GET /` shows the host's Tailscale state from a summary at most 3 minutes old — connected, connected with warnings (listed), or the reason it is not — and says so when the summary is stale or missing.
8. No admin page or action is reachable without a valid Access token for the admin application, by any route.
9. From the admin menu, the owner can save, restart, stop and start each Minecraft server, and see progress until the server is healthy or the action has failed. Players online are warned before a restart or stop.
10. `GET /` shows each configured media service as up or down, refreshed at least every minute, using no credential and revealing no address. A card leads to the service only through Access.

## Out of scope

- Accepting input or forms on the public hostname
- Reporting on other apps or services, other than the read-only Minecraft status query, the host's Tailscale summary, and credential-free health checks of the media services
- Holding an API key or login for any service it reports on, or acting on one (starting, stopping or queueing)
- Minecraft player names on the public page, player positions, or anything that needs a Minecraft credential such as RCON
- A console or free-text commands of any kind; Docker access; any access to `tailscaled` or the Tailscale API
- Writing to any database other than its own
