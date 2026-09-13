# Agent rules

Rules for any AI agent working in this repository. Read this, then `PRODUCT.md`, before changing anything.

**Operating rule: branch = work · pull request = validation · main = live.**

Anything merged to `main` is deployed automatically. There is no staging step between a merge and production.

---

## Before you start

1. Read `PRODUCT.md` — what this project is for and how success is judged.
2. Read `README.md` — the hosting profile, configuration and data this project declares.
3. Confirm you are on a feature branch, not `main`. Create one if needed: `git switch -c <short-description>`.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Run locally | `npm run dev` — http://localhost:3000 |
| Type check | `npm run check` |
| Test | `npm test` |
| Build | `npm run build` |
| Scan for secrets | `npm run secrets` |

Run `check`, `test` and `build` before every push. CI runs the same commands and a pull request cannot merge until they pass.

Requires Node 24 (see `.nvmrc`) and, for the secrets scan, `gitleaks` (`brew install gitleaks`).

## What you may do, must ask about, and must never do

| You may | Ask first before | Never |
|---|---|---|
| Edit code, tests and docs in this repository | Changing anything in `.github/workflows/` | Commit a secret, token, password or filled-in `.env` |
| Run the commands above | Adding a persistent service, database or volume | Bypass, skip or weaken a required check |
| Create branches, commits and pull requests | Changing authentication or who can reach the app | Push directly to `main` or merge your own pull request |
| Add dependencies that the task needs | Writing or running a database migration | Edit production over SSH or change the server by hand |
| | Changing the hosting profile | Mount the Docker socket, use `privileged` or host networking |
| | Deleting data or changing the backup declaration | Touch Minecraft, the children's games or backup jobs |

## This repository is public

Everything committed is visible to anyone, permanently. Rewriting history does not undo a leak — assume it has already been copied.

Never commit:

- Secrets of any kind, including generated ones such as database passwords
- `.env` or any copy of it. `.env.example` holds **variable names only**, with empty values
- IP addresses, internal hostnames, server paths, tunnel IDs or Cloudflare account details
- Personal data, including in tests and fixtures

Configuration comes from environment variables. Compose files reference variables, never real addresses. If a value is needed in production, add its **name** to `.env.example` and to the configuration table in `README.md`, and say so in the pull request.

Before committing, `gitleaks git --pre-commit --staged --redact .` checks what is staged. CI runs gitleaks on every pull request as a required check.

## Standards

- **TypeScript, strict.** Node runs `.ts` files directly in development. Use only erasable syntax — no `enum`, `namespace` or parameter properties — `npm run check` enforces this.
- **Relative imports use the `.ts` extension**, e.g. `import { loadConfig } from "./config.ts"`.
- **Tests live in `tests/`** and use the built-in `node:test` runner. New behaviour needs a test.
- **Keep dependencies few.** Prefer the Node standard library. Justify each new dependency in the pull request.
- **Health endpoint.** `GET /healthz` must keep returning `200` when the app is able to serve. The container health check depends on it.
- **Configuration** is read in one place, `src/config.ts`, and validated at startup.

## Pull requests

A pull request description states:

- what changed and why, linked to the acceptance criterion in `PRODUCT.md` it serves
- how it was tested
- any new configuration variable, dependency, persistent data or migration
- how to roll it back, if that is anything other than reverting the commit

## Definition of done

- Acceptance criteria in `PRODUCT.md` are met and automated checks pass
- The change has gone from a feature branch through a pull request
- The deployed version can be tied to a Git commit
- Health verification succeeds and logs contain no new material error
- Rollback is tested or its exact procedure is documented
- Persistent data and backup treatment are documented in `README.md`
- `README.md` reflects the released behaviour
