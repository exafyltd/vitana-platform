---
lane: command-hub-tenant-module
state: ready
next_actor: kiro
depends_on: [tenant-admin-api]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/frontend/command-hub/tenant-admin.js
  - services/gateway/src/frontend/command-hub/tenant-admin.css
  - services/gateway/src/frontend/command-hub/modules.json
  - services/gateway/src/frontend/command-hub/index.html
  - services/gateway/src/frontend/command-hub/app.js
  - services/gateway/test/mt-tenant-admin-command-hub-*.test.ts
  - scripts/ci/command-hub-ownership-guard.js
updated: 2026-11-01T15:50Z
repos: [exafyltd/vitana-platform]
---
# Command Hub tenant module — NEW module, no big app.js edits (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin-r2/plan.md` (authoritative) and the `command-hub-tenant-module` section of `tasks.md`.
Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

A NEW `tenant-admin.js` `kind:"module"` file + `tenant-admin.css`, registered in `modules.json` and `index.html`,
exposing `window.TenantAdmin.render()` the way `loops-catalog.js` is registered `kind:"module"` (`modules.json:6`,
`index.html` script tags). **`app.js` gets ONLY the one render-switch case line** that calls `window.TenantAdmin.
render()` — no large app.js edits (this is why `app.js` is in `paths`: the single-line case, nothing more; the
reviewer checks the diff is one case). CSP: external file only, no inline JS/CSS, every text node via `textContent`,
all fetches through `buildContextHeaders()`. Lists tenants, shows readiness + lifecycle, triggers deactivate/archive
and first-admin invitation delivery. **exafy-admin only + server-gated** (the named dark-by-default exception). The
lane adds its own `docs/validation/<vtid>/` in the PR.

**CI ownership guard (REQUIRED).** The Command Hub directory is CI-protected: `scripts/ci/command-hub-ownership-guard.js:15`
`PROTECTED_PATH = 'services/gateway/src/frontend/command-hub/'`, and `:1051` `ALLOWED_VTID_PATTERN` is a VTID/marker
allowlist the guard tests the branch name / PR title against (`:1115`), `process.exit(1)` on no match. This lane edits
that guard to APPEND its allocated VTID to `ALLOWED_VTID_PATTERN` — the one-line pattern update every prior Command Hub
VTID made (e.g. VTID-05084) — in the SAME PR as the module files. **TODO (do once PLAN-SPAR writes the VTID):** at
`scripts/ci/command-hub-ownership-guard.js:1051`, add `|VTID-xxxxx` to the `ALLOWED_VTID_PATTERN` regex. That guard
script is the only path outside the command-hub directory this lane touches and is listed in `paths` for exactly this.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, no write endpoint against any live system. Work only
inside the allowed paths. Branch `kiro/mt-tenant-admin-r2/command-hub-tenant-module`; PR title `VTID-xxxxx (mt-tenant-
admin/command-hub-tenant-module): …`; commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane:
mt-tenant-admin-r2/command-hub-tenant-module`. When the PR is open: set `state: in-review`, `next_actor: kiro`,
`pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:50Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-tenant-admin/command-hub-tenant-module`. Versions day-shifted to `20261102070*`. Executor and reviewer follow today's §3a/§7 rules.
