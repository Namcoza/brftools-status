# Product

## Purpose

A small status page. It shows the release history of this app: every time a new version starts, it records the version (commit SHA) and start time. It also shows whether the family's Minecraft servers are up and how many players are online. It is the pilot for the P410 Docker deployment path — its main value is proving that path, not the page itself.

## Users

Brendon, the family, and anyone who visits the hostname. From any network.

## Hosting profile

P410 Docker. It needs a server process and PostgreSQL.

## Access

Public. The page shows start times and commit SHAs, which are already public in this repository, and for each Minecraft server its name, state, version, player counts, a join address and a map link. Player names are never shown. Which addresses appear is production configuration, not part of this repository.

## Data

Release history in its own `status` database on the P410's PostgreSQL. No personal data. Replaceable: losing it loses only history. Minecraft status is held in memory only and is not stored.

## Acceptance criteria

1. Merging a passing pull request to `main` publishes an image tagged with the full commit SHA, and the P410 runs it without manual steps.
2. `GET /healthz` returns `200` with the running version only when the database is reachable, and `503` otherwise. Minecraft server state never changes the status code.
3. `GET /` lists releases newest first, and a rollback shows up as an older version starting again.
4. A release whose health check fails is replaced by the previous version automatically.
5. The previous release can be restored within 15 minutes.
6. `GET /` shows each configured Minecraft server as online or offline, with version and `online / max` players when online, refreshed at least every minute, and never lists player names.

## Out of scope

- Accepting any input, forms or authentication
- Reporting on other apps or services, other than the read-only Minecraft status query
- Player names, positions or anything that needs a Minecraft credential such as RCON
- Writing to any database other than its own
