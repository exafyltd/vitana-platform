---
slug: mt-tenant-admin
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: parked
updated: 2026-10-20T16:41Z
parked_from: drafted
---
# Handoff — mt-tenant-admin (program `docs/MULTI-TENANT-PLAN.md` §6 WS4 rest)

Spec 07 of the multi-tenant program. Provisioning core (B VTID-05150, C VTID-05151) is DONE and not re-planned here.
This spec covers the WS4 rest: invitation accept page outside the admin guard (email match + role allowlist UX; the
S-G security enforcement is mt-track-s), scoped tenant-admin pages (moderation, signups, notifications, users, audit),
a minimal Command Hub tenant module as a NEW module, guard/remove `/admin/init-events`, deactivate/archive end to end
(cross-spec O2), first-admin invitation delivery, and readiness extensions.

Plan: `plan.md` (between the `plan:begin`/`plan:end` markers — what PLAN-SPAR spars). Requirements, design and the
rules every successor follows: `requirements.md`, `design.md`. Tasks per lane: `tasks.md`.

Lanes (all `ready`, HELD at `next_actor: owner` until PLAN-SPAR allocates each VTID and flips it to kiro):
- `tenant-admin-moderation-db` — DB, seat `hotmail`, reviewer `jtadic`. P2/P3 + moderator tenant-scope migrations
  (`070100`/`070150`/`070600`), MIGRATION-QUEUE rows. Owns moderation (O4).
- `tenant-lifecycle-db` — DB, seat `hotmail`, reviewer `jtadic`. deactivate/archive RPCs + closing switch RPC
  (`070300`/`070350`). Owns deactivate/archive at the DB layer (O2).
- `tenant-admin-api` — gateway, seat `jtadic`, reviewer `hotmail`, depends on both DB lanes. Accept route, scoped
  admin reads (by `req.targetTenantId`), the `/admin/init-events` fixture update, readiness extension, lifecycle
  routes + deactivated-tenant posture.
- `command-hub-tenant-module` — gateway Command Hub, seat `jtadic`, reviewer `hotmail`, depends on `tenant-admin-api`.
  NEW `tenant-admin.js` module; one app.js render-switch case line only.
- `tenant-admin-pages` — vitana-v1, seat `exafyltd`, reviewer `jtadic`, depends on `tenant-admin-api`. Accept page
  outside the admin guard + scoped tenant-admin pages + the `/admin/init-events` frontend route guard.

DB lanes are separate from code lanes (§4.7). No governance-path lane exists in this spec, so no `executor: claude`
lane. VTIDs are allocated by PLAN-SPAR after the plan converges (not by Kiro).

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → drafted
Planner session kiro-hotmail-202610151618-b437 (seat hotmail) authored spec 07 and pushed it PUSH-FIRST as the
`plan(mt-tenant-admin)` PR. Premises re-verified read-only against vitana-platform-1 today (file:line in `plan.md`
§Problem). Cross-spec rulings applied: **C3** — mt-community-isolation's C3 migration reserved at `20261101070160`;
this spec keeps P2/P3 at `070100`/`070150` and moderator-tenant-scope at `070600`, all sorting around C3; MIGRATION-
QUEUE order P2 → P3 → C3 → deactivate(`070300`) → archive(`070350`) → moderator-tenant-scope(`070600`). **O2** — the
`tenant-lifecycle-db` lane owns deactivate/archive end to end (switch RPC, resolution, and the gateway lane adds the
deactivated-tenant API posture + tests); mt-m3 only references it. **O4** — `tenant-admin-moderation-db` (P2/P3) +
the moderator tenant-scope migration own moderation; no `moderation-tenant-db` lane created or referenced. Lane-count
merge rule applied: the invitation-accept UI merged into `tenant-admin-pages` (same repo+seat, compatible order).
Next: PLAN-SPAR spars the PR; the planner answers each round in `sparring/responses-<n>.md`; on convergence PLAN-SPAR
allocates the five VTIDs and flips each lane to kiro.

### 2026-10-17T10:23Z · kiro-hotmail-202610151618-b437 · internal-review fixes (drafted)
Fixed the two HIGH findings from `sparring/INTERNAL-REVIEW.json` (verdict REJECTED), re-verified read-only against
vitana-platform-1 / vitana-v1 today:
- **W1 — `getTenantId(req)` does not exist.** A full-tree grep (`services/gateway/src/**`) returns no exported
  `getTenantId`; only per-file locals (`admin-marketplace.ts:31`, `admin-community-marketplace.ts:30`, both reading
  `req.identity.tenant_id`) and a controller method `governance-controller.ts:39`. The real mechanism is
  `requireTenantAdmin` (`middleware/require-tenant-admin.ts`), which resolves the target tenant
  `req.params.tenantId || req.identity.tenant_id` (`:102`), bypasses for exafy-admin (`:97-99`), and attaches
  `req.targetTenantId` (`:160`). Rewrote the scoping mechanism to `req.targetTenantId` (caller's own =
  `req.identity.tenant_id`) and dropped the false claim that three admin routes already scope "via `getTenantId(req)`"
  in: `plan.md` problem 2 + the tenant-admin-api Fix bullet, `requirements.md` R2.1, `design.md` (What exists +
  tenant-admin-api), `tasks.md` A2 + the lane acceptance, and `lanes/tenant-admin-api.md`.
- **W2 — `/admin/init-events` is a vitana-v1 FRONTEND page, not a gateway surface.**
  `vitana-v1/src/pages/admin/InitEvents.tsx` is a static dev helper (shows a SQL script, `window.open`s the Supabase
  dashboard; calls no gateway endpoint; not currently routed in `App.tsx`). It appears in the gateway route-inventory
  fixture `e2e/fixtures/routes.ts` under `ADMIN_ROUTES` (corrected from the review's "PUBLIC_ROUTES" wording — verified
  it is in `ADMIN_ROUTES`). The frontend guard (admin `RouteGuard` in `App.tsx`, or remove the page) moved to the
  `tenant-admin-pages` lane (its `src/App.tsx` is already in `paths`); the `tenant-admin-api` lane now only updates the
  fixture entry it legitimately owns, and no gateway `admin-init-events.ts` is created. Removed
  `services/gateway/src/routes/admin-init-events.ts` from the `tenant-admin-api` lane `paths` and from `tasks.md`
  Allowed paths. Updated `plan.md` problem 3 + both Fix bullets, `requirements.md` R3, `design.md`, `tasks.md` A3/A6/P2b
  and both lane files.
No change to lane structure, migrations, ownership or the cross-spec rulings. Re-pushed the branch (same recipe) to
update the PR, re-ran the `queue.mjs` validators (0 errors), then deleted `sparring/INTERNAL-REVIEW.json` so a fresh
review round can run.

### 2026-10-17T13:40Z · kiro-hotmail-202610151618-b437 · internal-review fixes round 2 (drafted)
Fixed the one HIGH + one MEDIUM from `sparring/INTERNAL-REVIEW.json` (verdict REJECTED), re-verified read-only against
vitana-platform-1 today:
- **HIGH — the gateway invitation-accept route already exists and is hardened (VTID-05044); the spec wrongly told the
  executor to CREATE it.** Verified: `services/gateway/src/routes/tenant-admin/invitations.ts` exports `acceptRouter`
  (`acceptRouter.post('/accept/:token', requireAuth, …)` at `:186`), mounted at `/api/v1/admin/invitations`
  (`index.ts:501` destructure, `:1429` mount). It already enforces confirmed-email + email-match (403
  `EMAIL_UNVERIFIED`/`EMAIL_MISMATCH`, `:208-233`), role-allowlist re-check incl. super-admin-only refusal (409
  `INVITATION_ROLES_INVALID`, `:237-268`), expiry (410 `EXPIRED`, `:200`), atomic claim-before-grant (409 `ALREADY_USED`,
  `:289-299`), grants only validated roles (`upsertUserPermittedRole`, `:312-319`). A full-tree search confirms NO
  `admin-invitations.ts` exists anywhere. Adopted the review's preferred fix: dropped all gateway accept-route work.
  Removed `services/gateway/src/routes/admin-invitations.ts` from the `tenant-admin-api` lane `paths` (and from
  `tasks.md` Allowed paths — the two still match exactly) and deleted task A1. Rewrote `plan.md` Problem #1 + the
  tenant-admin-api/tenant-admin-pages Fix bullets + Tests + Out of scope + Depends on; `requirements.md` R1 (now a
  page-only requirement on lane `tenant-admin-pages`, consuming the existing endpoint) + Program position + Not in this
  slice; `design.md` What-exists (added the DONE route), tenant-admin-api (no accept work), tenant-admin-pages, and
  rule 3; `tasks.md` A6/P2/P6; and both lane files. The accept route's behaviour is NOT re-tested here (owned by
  VTID-05044); the page-level accept behaviour is proven in the vitana-v1 Vitest/staging specs.
- **MEDIUM — the S-G ownership split was stated against an already-enforced surface.** Reframed every S-G reference as
  defence-in-depth: the accept route already enforces email-match + role-allowlist (VTID-05044); mt-track-s adds a
  SECOND, auth-layer line of defence; this spec adds no enforcement at either layer, only the accept-page UX. Updated
  `plan.md` (Problem #1, Out of scope, Depends on), `requirements.md` (R1 preamble, Program position), `design.md`
  (tenant-admin-api, tenant-admin-pages) and `lanes/tenant-admin-pages.md`.
No change to lane count, structure, migrations, ownership (O2/O4), the C3 ordering, or the cross-spec rulings. Re-ran
the `queue.mjs` validators (0 errors), re-pushed the branch (same recipe) to update the PR, then deleted
`sparring/INTERNAL-REVIEW.json` so a fresh review round can run.

### 2026-10-17T11:12Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:31Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T19:58Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:07Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:17Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:23Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:31Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:36Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-20T16:41Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.
