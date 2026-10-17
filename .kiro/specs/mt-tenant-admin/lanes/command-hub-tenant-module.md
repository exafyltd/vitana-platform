---
lane: command-hub-tenant-module
state: ready
next_actor: owner
depends_on: [tenant-admin-api]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/frontend/command-hub/tenant-admin.js
  - services/gateway/src/frontend/command-hub/tenant-admin.css
  - services/gateway/src/frontend/command-hub/modules.json
  - services/gateway/src/frontend/command-hub/index.html
  - services/gateway/src/frontend/command-hub/app.js
  - services/gateway/test/mt-tenant-admin-command-hub-*.test.ts
updated: 2026-10-15T16:18Z
---
# Command Hub tenant module — NEW module, no big app.js edits (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin/plan.md` (authoritative) and the `command-hub-tenant-module` section of `tasks.md`.
Design and the rules you must follow: `design.md`.

**HELD until PLAN-SPAR allocates the VTID** (`next_actor: owner`, no `vtid`). PLAN-SPAR writes the VTID in and flips
`next_actor` to kiro on a converged plan. Do not self-allocate. **Depends on** `tenant-admin-api` (consumes its
routes).

A NEW `tenant-admin.js` `kind:"module"` file + `tenant-admin.css`, registered in `modules.json` and `index.html`,
exposing `window.TenantAdmin.render()` the way `loops-catalog.js` exposes `window.LoopsCatalog` (`modules.json:7`,
`index.html` script tags). **`app.js` gets ONLY the one render-switch case line** that calls `window.TenantAdmin.
render()` — no large app.js edits (this is why `app.js` is in `paths`: the single-line case, nothing more; the
reviewer checks the diff is one case). CSP: external file only, no inline JS/CSS, every text node via `textContent`,
all fetches through `buildContextHeaders()`. Lists tenants, shows readiness + lifecycle, triggers deactivate/archive
and first-admin invitation delivery. **exafy-admin only + server-gated** (the named dark-by-default exception). The
lane adds its own `docs/validation/<vtid>/` in the PR.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, no write endpoint against any live system. Work only
inside the allowed paths. Branch `kiro/mt-tenant-admin/command-hub-tenant-module`; PR title `VTID-xxxxx (mt-tenant-
admin/command-hub-tenant-module): …`; commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane:
mt-tenant-admin/command-hub-tenant-module`. When the PR is open: set `state: in-review`, `next_actor: kiro`,
`pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-* program planner (session kiro-hotmail-202610151618-b437, holding `mt-tenant-admin/_plan`). Command
Hub is a gateway surface → seat `jtadic`, reviewer seat `hotmail` (≠ seat). The command-hub path is NOT a governance
path (not under `.github`/`.claude`/`.kiro/steering`/`scripts/collab`), so it stays executor: kiro. Held for PLAN-SPAR.
