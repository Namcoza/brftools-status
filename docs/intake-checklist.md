# Project intake checklist

Answer these before creating a project from the template. The answers become `PRODUCT.md` and decide the hosting profile. If an answer is "don't know yet", write that — it is better than a guess an agent will build on.

## 1. Users

- Who will use it?
- From which devices and networks — home only, or anywhere?

## 2. Hosting class

Does it need any of the following?

- [ ] A server process (Node running continuously, handling requests)
- [ ] PostgreSQL or Redis
- [ ] Background or scheduled jobs
- [ ] Files that must survive a restart
- [ ] Data or integrations that belong on the home server

**None ticked → static site on Cloudflare.** Any ticked → P410 Docker. Default to the static site whenever it is genuinely enough. See `deployment-profiles.md`.

## 3. Data

- What does it store?
- Is any of it personal or sensitive?
- If it were lost, could it be recreated, or is it gone?

## 4. Access

- [ ] Public — anyone with the URL
- [ ] Family-only — behind Cloudflare Access, listed email addresses
- [ ] Owner-only — behind Cloudflare Access, Brendon only

Anything that accepts input, stores data or administers something is not public by default.

## 5. Success

- What does "working" look like?
- How will it be tested — what are the acceptance criteria?

## 6. Backup and recovery

- What must be backed up? ("Nothing — it is rebuilt from the repository" is a valid answer for most static sites.)
- How will a restore be proven to work?
- Does it need a database migration strategy?

## Record the decision

- [ ] `PRODUCT.md` filled in from the answers above
- [ ] Hosting profile written into `README.md`
- [ ] Unneeded profile files removed (see `deployment-profiles.md`)
- [ ] Persistent data and backup declaration written into `README.md`
