---
lane: pack-intake-admin
state: ready
next_actor: kiro
depends_on: [pack-intake-db]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/routes/tenant-admin/pack-intake.ts
  - services/gateway/src/routes/tenant-admin/pack-intake-repository.ts
  - services/gateway/src/services/tenant-launch/tenant-feature-flag.ts
  - services/gateway/src/services/tenant-launch/tenant-feature-flag-repository.ts
  - services/gateway/src/services/tenant-launch/health-claim-linter.ts
  - services/gateway/src/services/tenant-launch/leftover-brand-linter.ts
  - services/gateway/src/services/tenant-launch/undated-claim-linter.ts
  - services/gateway/src/services/tenant-launch/content-pipeline.ts
  - services/gateway/src/services/tenant-launch/publish.ts
  - services/gateway/src/index.ts
  - services/gateway/test/mt-launch-tenant-feature-flag.test.ts
  - services/gateway/test/mt-launch-linters.test.ts
  - services/gateway/test/mt-launch-pack-intake.test.ts
  - docs/validation/VTID-mt-launch-pack-intake/**
updated: 2026-10-21T13:58Z
vtid: VTID-05323
---
# pack-intake-admin — intake API + AI content pipeline + linters (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `pack-intake-admin` section of `../tasks.md` (tasks P1–P5, allowed paths,
acceptance). Design + successor rules: `../design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR converges and allocates this lane's VTID; it then flips to `kiro`.
Depends on `pack-intake-db` (the two tables + readiness function) and, cross-spec, on `mt-packs`'s
`tenant_content_overrides` — the publish target. Build order: start after `pack-intake-db`'s migrations are merged; the
publish path stays dark (`mt.launch_pipeline` off) until `tenant_content_overrides` exists — and independently of the
flag a missing table (`42P01`/`PGRST205`) answers 409 `DEPENDENCY_NOT_READY` with the row unchanged — so the lane can ship intake
+ linters even if WS5 slips.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`/another lane,
no merge/approve/deploy/workflow dispatch, no Supabase or AWS write, never call a write endpoint against any live
system. Work only inside the allowed paths. This lane also CREATES the per-tenant dark-flag resolver
`services/gateway/src/services/tenant-launch/tenant-feature-flag.ts` (+ its repo seam), used by all three code lanes:
`isTenantFeatureLive(tenantId, key)` reads `tenant_settings.feature_flags.<key>` strictly `=== true`, default OFF,
error ⇒ OFF, 5-min cache — a copy of `services/data-export-consent.ts`, NOT `isFeatureLive` (`feature-flags.ts:81`),
which is single-arg/global and cannot express a per-tenant flag. Three linters are pure functions; publish writes to
`tenant_content_overrides` only from `signed_off`; everything behind `isTenantFeatureLive(tenantId, 'mt.launch_pipeline')`.
Add this lane's own `docs/validation/VTID-mt-launch-pack-intake/` (scope.json, staging-tests.json, plan copy).

Branch `kiro/mt-launch/pack-intake-admin`; PR title `VTID-xxxxx (mt-launch/pack-intake-admin): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-launch/pack-intake-admin`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Intake API (`requireTenantAdmin` + exafy-admin, tenant from path only) + content pipeline + three
linters; publish to `tenant_content_overrides` from `signed_off` only, dark by default. seat `jtadic` (gateway),
reviewer `exafy`.

### 2026-10-20T19:00Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (0de6a378) — no path change
R1-F1 full resolver path `services/gateway/src/services/tenant-launch/tenant-feature-flag.ts`; R1-F3 `DEPENDENCY_NOT_READY` publish guard.

### 2026-10-21T13:58Z · ci-plan-spar · ready (VTID allocated)
VTID-05323 allocated after policy approval (converged-auto-v1).
