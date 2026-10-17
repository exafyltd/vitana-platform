---
lane: support-landing
state: ready
next_actor: owner
depends_on: [pack-intake-admin]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/tenant-launch/support-routing.ts
  - services/gateway/src/routes/feedback-admin.ts
  - services/gateway/src/routes/feedback-intake.ts
  - services/gateway/src/routes/landing-seo.ts
  - services/gateway/test/mt-launch-support-landing.test.ts
  - docs/validation/VTID-mt-launch-support-landing/**
updated: 2026-10-15T16:40Z
---
# support-landing — per-tenant support routing + landing SEO/OG (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `support-landing` section of `../tasks.md` (tasks P1–P4, allowed paths,
acceptance). Design + successor rules: `../design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR converges and allocates this lane's VTID; it then flips to `kiro`.
Depends only on `pack-intake-admin` for its per-tenant dark-flag resolver (`services/tenant-launch/tenant-feature-flag.ts`,
imported read-only — no path entry needed). Per-tenant support routing resolver + landing SEO/OG surfaced from the brand
pack; referral/invite attribution is already tenant-scoped and is **not** changed here. Everything dark behind
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
