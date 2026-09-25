# Product

## Purpose

A small status page. It shows the release history of this app: every time a new version starts, it records the version (commit SHA) and start time. It also shows whether the family's Minecraft servers are up and how many players are online, and whether the host is connected to its Tailscale network, for troubleshooting remote access. A private admin menu lets the owner save, restart, stop and start the Minecraft servers from a browser, without SSH, and keep the list of people invited to the status page. It is the pilot for the P410 Docker deployment path — its main value is proving that path, not the page itself.

## Users

- **Status page:** Brendon and the people he invites, from any network, after signing in with their Google account through Cloudflare Access.
- **Admin menu:** Brendon only, after a Cloudflare Access login, checked by the app against the configured owner.

## Hosting profile

P410 Docker. It needs a server process and PostgreSQL. It reads files written by the host and writes admin requests for the host to act on.

## Access

- **Status hostname:** invited users only. It sits behind a Cloudflare Access application with Google login, and the app verifies the Access token on every request and lets in only the owner and invited users, so a request that reaches the app any other way gets nothing. `/healthz` is the one route answered without sign-in, for the container health check; it shows the version and states only. The page shows:
  - Start times and commit SHAs, which are already public in this repository.
  - For each Minecraft server: name, state, version, player counts, a join address and a map link.
  - The host's Tailscale state, relay, health warnings, and the names, OS and online state of the other devices on the tailnet.
  - For each media service: its name, whether it is up, and its version where that is free. **No address, port or link target.** Only the owner is shown the link to open a service, which goes through the admin menu.
  - Minecraft player names are never shown. Tailscale device names are shown by the owner's decision; IP addresses and tailnet names are not.
- **Admin hostname:** private. It sits behind a Cloudflare Access application, and the app verifies the Access token on every request, so a request that reaches the app any other way gets nothing. It shows player names, a recent server log with IP addresses removed, and the emails of invited users.
- Which addresses and hostnames are used is production configuration, not part of this repository.

## Data

- **Release history:** in its own `status` database on the P410's PostgreSQL. No personal data. Replaceable: losing it loses only history.
- **Invited users:** the Google account emails of people invited to the status page, with when they were added and last signed in, in the same database. Personal data, kept only while they are invited. Losing it means re-inviting them.
- **Minecraft status:** held in memory only.
- **Tailscale summary, admin server state and action history:** host-written files, read on each view.
- **Admin requests:** small files handed to the host and deleted by it.
- Apart from releases and invited users, none of these is stored by the app.

## Acceptance criteria

1. Merging a passing pull request to `main` publishes an image tagged with the full commit SHA, and the P410 runs it without manual steps.
2. `GET /healthz` returns `200` with the running version only when the database is reachable, and `503` otherwise. Minecraft, Tailscale and admin state never change the status code.
3. For a signed-in, invited visitor, `GET /` lists releases newest first, and a rollback shows up as an older version starting again.
4. A release whose health check fails is replaced by the previous version automatically.
5. The previous release can be restored within 15 minutes.
6. `GET /` shows each configured Minecraft server as online or offline, with version and `online / max` players when online, refreshed at least every minute. It never lists player names.
7. `GET /` shows the host's Tailscale state from a summary at most 3 minutes old — connected, connected with warnings (listed), or the reason it is not — and says so when the summary is stale or missing.
8. No admin page or action is reachable without a valid Access token for the admin application, by any route.
9. From the admin menu, the owner can save, restart, stop and start each Minecraft server, and see progress until the server is healthy or the action has failed. Players online are warned before a restart or stop.
10. `GET /` shows each configured media service as up or down, refreshed at least every minute, using no credential and revealing no address. A card leads to the service only through Access.
11. From the admin menu, the owner can invite a person by Google account email, see whether they have signed in, and remove them. With an owner configured, no other account can use the admin menu, even with a valid Access token.
12. With sign-in on, no status page is served, by any route, without a valid Access token for the status application and an email that is the owner's or invited. A Google account that is not invited is told so and shown nothing else, and a removed user is refused on their next request.

## Out of scope

- Accepting input or forms on the status hostname
- Reporting on other apps or services, other than the read-only Minecraft status query, the host's Tailscale summary, and credential-free health checks of the media services
- Holding an API key or login for any service it reports on, or acting on one (starting, stopping or queueing)
- Minecraft player names on the public page, player positions, or anything that needs a Minecraft credential such as RCON
- A console or free-text commands of any kind; Docker access; any access to `tailscaled` or the Tailscale API
- Writing to any database other than its own
