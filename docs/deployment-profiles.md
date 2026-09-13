# Deployment profiles

Every project uses exactly one of two profiles. The intake checklist decides which. **Default to the static site** — use the P410 only when the project genuinely needs server-side compute or local persistent data.

Both profiles share the same rule: **merging to `main` deploys.** Nothing reaches production any other way.

| | Static site (Cloudflare) | P410 Docker |
|---|---|---|
| Use when | Output is static HTML, CSS and JavaScript | Needs a server process, PostgreSQL, Redis, background jobs or durable files |
| Runs as | Cloudflare Worker serving static assets | Container on the P410 |
| Built by | Cloudflare Workers Builds, on push | GitHub Actions, on merge to `main` |
| Release unit | Worker version | Container image tagged with the commit SHA |
| Pull request preview | Yes — branch preview URL posted on the pull request | No (deferred) |
| Rollback | Roll back to a previous Worker version | Re-point at the previous image digest |
| Target rollback time | Under 10 minutes | Under 15 minutes |

> **Why a Worker and not Cloudflare Pages?** Cloudflare's dashboard now creates Workers by default, and a static-assets Worker gives everything the Pages path did: Git deploys from `main`, branch previews, custom domains and rollback. Proven on the first pilot, `brftools-home`.

---

## Profile A — Static site on Cloudflare

### Files

Delete what a static site does not use:

- `Dockerfile`, `.dockerignore`, `compose.yml`
- the `docker` job in `.github/workflows/ci.yml`, and `docker` from the ruleset's required checks

Keep `src/` and its tests: the Node server is the local dev server for `npm run dev`. It never runs in production. Keep `public/` — it is the site. `npm run build` writes it to `dist/public/`.

Add wrangler, pinned to an exact version, and a `wrangler.jsonc` at the repository root:

```bash
npm install --save-dev --save-exact wrangler@<current version>
```

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "<project-name>",
  "compatibility_date": "<today, YYYY-MM-DD>",
  "assets": {
    "directory": "./dist/public"
  },
  // workers.dev stays on because branch preview URLs are served from it.
  "workers_dev": true,
  "preview_urls": true
}
```

**Commit `wrangler.jsonc` before connecting Cloudflare.** Without it, wrangler guesses the settings inside every build — and guesses `public/` rather than `dist/public/`.

Custom domains are **not** set in `wrangler.jsonc`; they are attached in the dashboard, so no production hostname lives in the repository. `.wrangler/` is already gitignored.

**Never run `wrangler deploy` by hand.** It would bypass the pull request.

### Cloudflare setup

Once per project, in the Cloudflare dashboard:

1. **Workers & Pages → Create → Import a repository**, and connect GitHub.
2. On GitHub's install screen choose **Only select repositories** and pick **this repository only**. (For later projects, add each repository to the existing installation the same way.)
3. Select the repository. Settings:

   | Setting | Value |
   |---|---|
   | Project name | same as `name` in `wrangler.jsonc` |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |
   | Non-production branch builds | enabled — `npx wrangler versions upload` |

   Node 24 is picked up from `.nvmrc`; no `NODE_VERSION` variable is needed.
4. After the first successful build: **Settings → Domains & Routes → Add → Custom domain**, once per hostname. DNS records and certificates are created automatically when the zone is on Cloudflare.

### Verify and roll back

- **Pull request:** a `Workers Builds: <project>` check appears alongside `test` and `gitleaks`, and a Cloudflare bot comment gives the branch preview URL. Previews never change production.
- **After merge:** the custom domain serves the change, and the Worker's **Deployments** tab shows a version from the merge commit.
- **Roll back:** Worker → **Deployments** → the last good version → **Rollback**. Then revert the bad commit through a pull request so the next merge does not re-publish it.

---

## Profile B — P410 Docker

### Files

Keep everything. The template's `Dockerfile` and `compose.yml` already satisfy the container rules below.

`.github/workflows/deploy.yml` — building and publishing the image to GHCR — is added in **Phase 3** of the platform build, not by the template.

### Container rules

These are checked in review and must not be relaxed without asking:

- Health check present and passing (`GET /healthz`)
- `mem_limit` and `cpus` set in `compose.yml` — the host also runs the family's Minecraft servers
- Runs as a non-root user; `read_only`, `no-new-privileges`, all capabilities dropped
- Not `privileged`, no host networking, no Docker socket mount
- No published ports — the reverse proxy reaches the app over the shared network
- Persistent data declared as a named volume, and listed in `README.md` with its backup treatment

### How a release reaches the server

1. Merge to `main`.
2. GitHub Actions tests the code and publishes an image to GHCR, tagged with the full commit SHA.
3. The P410's deploy script pulls that image, starts it, and waits for the health check.
4. If the health check fails, the script returns to the previous image automatically.

Routing (reverse proxy and public hostname) is configured on the platform, not in this repository.

### Configuration

Real values live only on the server. The repository holds variable **names** in `.env.example`.

### Verify and roll back

- **Verify:** `GET /healthz` returns `200` with `version` equal to the merged commit SHA.
- **Roll back:** run the deploy script against the previous image digest. Database changes are not reversed by rolling back an image — follow the migration's own recovery note.
