# Product

## Purpose

A small page showing the release history of this app: every time a new version starts, it records the version (commit SHA) and start time. It is the pilot for the P410 Docker deployment path — its value is proving that path, not the page itself.

## Users

Brendon, and anyone who visits the hostname. From any network.

## Hosting profile

P410 Docker. It needs a server process and PostgreSQL.

## Access

Public. The page shows only start times and commit SHAs, which are already public in this repository.

## Data

Release history in its own `status` database on the P410's PostgreSQL. No personal data. Replaceable: losing it loses only history.

## Acceptance criteria

1. Merging a passing pull request to `main` publishes an image tagged with the full commit SHA, and the P410 runs it without manual steps.
2. `GET /healthz` returns `200` with the running version only when the database is reachable, and `503` otherwise.
3. `GET /` lists releases newest first, and a rollback shows up as an older version starting again.
4. A release whose health check fails is replaced by the previous version automatically.
5. The previous release can be restored within 15 minutes.

## Out of scope

- Accepting any input, forms or authentication
- Reporting on other apps or services
- Writing to any database other than its own
