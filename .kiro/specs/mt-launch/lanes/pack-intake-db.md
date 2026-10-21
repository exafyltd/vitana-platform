---
lane: pack-intake-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101110000_mt_launch_tenant_pack_intake.sql
  - supabase/migrations/20261101110100_mt_launch_tenant_content_pipeline.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-launch-pack-intake-pgtap.test.ts
updated: 2026-10-21T17:04Z
vtid: VTID-05324
---
# pack-intake-db — tenant pack intake + content pipeline tables (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `pack-intake-db` section of `../tasks.md` (tasks P1–P5, allowed paths,
acceptance). Design + successor rules: `../design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR spars this plan, converges and allocates this lane's VTID — PLAN-SPAR then
flips `next_actor` to `kiro` itself. Do not build before that.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS write. A database change is a migration file in
this PR; it is applied in production by Claude via RUN-MIGRATION after merge, in MIGRATION-QUEUE order, AFTER WS5's
`tenant_content_overrides`. Expand-only, service-role-only RLS. The lane adds its own `docs/validation/<vtid>/`
(rollback SQL + read-only pre/post checks). Renumber the two migrations if a later one exists at build time.

Branch `kiro/mt-launch/pack-intake-db`; PR title `VTID-xxxxx (mt-launch/pack-intake-db): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-launch/pack-intake-db`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Two expand-only tables (`tenant_pack_intake`, `tenant_content_pipeline`) + a read-only
`get_tenant_launch_readiness()` that never reads a health table. seat `hotmail` (DB/migrations), reviewer `exafy`.

### 2026-10-20T19:00Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (0de6a378) — no path change
R1-F5: `get_tenant_launch_readiness` is SECURITY INVOKER, STABLE, `SET search_path = public, pg_catalog`, EXECUTE only
for service_role.

### 2026-10-21T13:58Z · ci-plan-spar · ready (VTID allocated)
VTID-05324 allocated after policy approval (converged-auto-v1).
### 2026-10-21T16:16Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:44Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:46Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:50Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:52Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:56Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T16:58Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:02Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-10-21T17:04Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
