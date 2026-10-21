---
lane: support-landing
state: ready
next_actor: kiro
depends_on: [pack-intake-admin]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/tenant-launch/support-routing.ts
  - services/gateway/src/routes/feedback-admin.ts
  - services/gateway/src/routes/feedback-intake.ts
  - services/gateway/src/routes/landing-seo.ts
  - services/gateway/src/routes/community-invites.ts
  - services/gateway/test/mt-launch-support-landing.test.ts
  - docs/validation/VTID-mt-launch-support-landing/**
updated: 2026-10-21T13:58Z
vtid: VTID-05325
---
# support-landing — per-tenant support routing + landing SEO/OG (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `support-landing` section of `../tasks.md` (tasks P1–P4, allowed paths,
acceptance). Design + successor rules: `../design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR converges and allocates this lane's VTID; it then flips to `kiro`.
Depends only on `pack-intake-admin` for its per-tenant dark-flag resolver (`services/gateway/src/services/tenant-launch/tenant-feature-flag.ts`,
imported read-only — no path entry needed). Per-tenant support routing resolver + landing SEO/OG surfaced from the brand
pack; the `/claim` invite OASIS event (`community-invites.ts:72-80`) gains `tenant_id` = `resolvePrimaryTenant(identity.user_id)`
(service-role, membership-authoritative; never the JWT active tenant, never `DEFAULT_TENANT_ID`). `admin-signups.ts` signup attribution is NOT edited here — it is
owned by mt-jobs `jobs-automation-actor-tenant` (VTID-05267, branch `kiro/mt-jobs/plan` @ `6684e769`). Gate: before the
PR, confirm on `origin/main` that VTID-05267 merged; otherwise stop with a log entry and `next_actor: claude`. Everything dark behind
`isTenantFeatureLive(tenantId, 'mt.launch_support')` — NOT `isFeatureLive` (`feature-flags.ts:81`), which is
single-arg/global and cannot express a per-tenant flag; with the flag off the ticket pipeline is byte-identical to
today, so `npm run test:support` (rule 42c) stays green — a contract change would add a scenario in the same PR.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`/another lane,
no merge/approve/deploy/workflow dispatch, no Supabase or AWS write, never call a live system. Add no new public-registry
key (reuse the Lane-C whitelist). Work only inside the allowed paths. Add
`docs/validation/VTID-mt-launch-support-landing/` (scope.json, staging-tests.json, plan copy).

Branch `kiro/mt-launch/support-landing`; PR title `VTID-xxxxx (mt-launch/support-landing): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-launch/support-landing`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Support-routing resolver called from feedback routes + landing SEO/OG read path, both dark. seat
`jtadic` (gateway), reviewer `exafy`.

### 2026-10-20T19:00Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (0de6a378) — paths changed
R1-F1 full resolver path; R1-F4 `/claim` event carries `tenant_id`, `admin-signups.ts` left to mt-jobs VTID-05267.
`paths` + `services/gateway/src/routes/community-invites.ts` (no other lane claims it).

### 2026-10-20T19:20Z · kiro-hotmail-202610151618-b437 · spar session 2 round 2 — no path change
R2-F1: VTID-05267 dependency cited with its artifact + a pre-PR merge gate. R2-F2: `/claim` tenant = `resolvePrimaryTenant` (service role), not the JWT active tenant.

### 2026-10-21T13:58Z · ci-plan-spar · ready (VTID allocated)
VTID-05325 allocated after policy approval (converged-auto-v1).
