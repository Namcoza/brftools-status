# brftools-template

Starting point for every new brftools project. It gives an AI agent everything it needs to work on a project without undocumented knowledge: a runnable TypeScript app, the checks every pull request must pass, the agent rules, and two documented deployment profiles.

**branch = work · pull request = validation · main = live**

---

## Start a new project from this template

1. Work through [`docs/intake-checklist.md`](docs/intake-checklist.md) and fill in [`PRODUCT.md`](PRODUCT.md).
2. On GitHub: **Use this template → Create a new repository.** Keep it public unless there is a reason not to.
3. Clone it and set it up:
   ```bash
   git clone https://github.com/<owner>/<new-project>.git
   cd <new-project>
   npm ci
   npm test
   ```
4. Rename the project: `name` in `package.json`, the title of this README, the `IMAGE` default in `compose.yml`.
5. Choose the hosting profile and remove the files it does not use — see [`docs/deployment-profiles.md`](docs/deployment-profiles.md). A static site also adds `wrangler.jsonc`, before connecting Cloudflare.
6. Rewrite this README's sections below for the project, and delete this "Start a new project" section.
7. Protect `main` — see [Repository settings](#repository-settings).

Then open a session with an agent in the project folder. `AGENTS.md` (and `CLAUDE.md`, which points to it) tells it the rest.

---

## Requirements

| Tool | Version | Install (Mac) |
|---|---|---|
| Node.js | 24 LTS (`.nvmrc`) | `brew install node@24 && brew link --overwrite node@24` — `node@24` is not linked onto the PATH by default |
| gitleaks | 8.x | `brew install gitleaks` |

Docker is not needed for local development. CI builds and tests the container image.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Run locally, reloading on change | `npm run dev` → http://localhost:3000 |
| Type check | `npm run check` |
| Test | `npm test` |
| Build | `npm run build` → `dist/` |
| Run the build | `npm start` |
| Scan for secrets | `npm run secrets` |

## Layout

```
AGENTS.md            rules for AI-assisted changes (CLAUDE.md points here)
PRODUCT.md           purpose, users and acceptance criteria
docs/                intake checklist, deployment profiles, decisions
src/                 application code — config.ts, app.ts, server.ts
public/              static assets; the whole site for static-site projects
tests/               node:test tests
scripts/             build helpers
Dockerfile           P410 profile only
compose.yml          P410 profile only — production runtime declaration
.env.example         variable names only; never values
.gitleaks.toml       secret-scanning rules
.github/workflows/   ci.yml — the required checks
```

## Hosting profile

<!-- Static site on Cloudflare, or P410 Docker. Delete the other. -->

**Not yet chosen.**

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3000` |
| `APP_VERSION` | Version reported by `/healthz`; CI sets it to the commit SHA | `dev` |
| `PUBLIC_DIR` | Directory served at `/` | `./public` |

Real values never go in the repository. Locally, copy `.env.example` to `.env`, which is gitignored.

## Persistent data

<!-- What the app stores, where, and how it is backed up and restored. -->

None. The app is stateless and rebuilt entirely from this repository.

## Deploy, verify, roll back

See [`docs/deployment-profiles.md`](docs/deployment-profiles.md) for the chosen profile. Replace this paragraph with the project's specific hostname-free steps once it is deployed.

- **Deploy:** merge a passing pull request to `main`.
- **Verify:** `GET /healthz` returns `{"status":"ok","version":"<commit sha>"}` (P410), or the site shows the change (static).
- **Roll back:** as described for the profile.

## Repository settings

Set once per repository, on GitHub under **Settings → Rules → Rulesets**, a ruleset targeting the default branch with:

- Require a pull request before merging
- Require status checks to pass: `test` and `gitleaks`, plus `docker` for the P410 profile
- Block force pushes
- Restrict deletions

And under **Settings → Code security**: secret scanning and push protection on.
