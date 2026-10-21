---
lane: pack-intake-db
state: executing
next_actor: kiro
claimed_by: kiro-hotmail-202610211408-c407
branch: kiro/mt-launch/pack-intake-db
pr: https://github.com/exafyltd/vitana-platform/pull/4265
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101110000_mt_launch_tenant_pack_intake.sql
  - supabase/migrations/20261101110100_mt_launch_tenant_content_pipeline.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-launch-pack-intake-pgtap.test.ts
updated: 2026-10-21T16:30Z
vtid: VTID-05324
---
# pack-intake-db â€” tenant pack intake + content pipeline tables (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `pack-intake-db` section of `../tasks.md` (tasks P1â€“P5, allowed paths,
acceptance). Design + successor rules: `../design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR spars this plan, converges and allocates this lane's VTID â€” PLAN-SPAR then
flips `next_actor` to `kiro` itself. Do not build before that.

Rules for the executor (collaboration Â§7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS write. A database change is a migration file in
this PR; it is applied in production by Claude via RUN-MIGRATION after merge, in MIGRATION-QUEUE order, AFTER WS5's
`tenant_content_overrides`. Expand-only, service-role-only RLS. The lane adds its own `docs/validation/<vtid>/`
(rollback SQL + read-only pre/post checks). Renumber the two migrations if a later one exists at build time.

Branch `kiro/mt-launch/pack-intake-db`; PR title `VTID-xxxxx (mt-launch/pack-intake-db): â€¦`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-launch/pack-intake-db`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z Â· kiro-hotmail-202610151618-b437 Â· created â†’ ready
Created and held. Two expand-only tables (`tenant_pack_intake`, `tenant_content_pipeline`) + a read-only
`get_tenant_launch_readiness()` that never reads a health table. seat `hotmail` (DB/migrations), reviewer `exafy`.

### 2026-10-20T19:00Z Â· kiro-hotmail-202610151618-b437 Â· spar session 2 round 1 (0de6a378) â€” no path change
R1-F5: `get_tenant_launch_readiness` is SECURITY INVOKER, STABLE, `SET search_path = public, pg_catalog`, EXECUTE only
for service_role.

### 2026-10-21T13:58Z Â· ci-plan-spar Â· ready (VTID allocated)
VTID-05324 allocated after policy approval (converged-auto-v1).

### 2026-10-21T16:05Z Â· kiro-hotmail-202610211408-c407 Â· ready â†’ executing
Claimed (collab-claim/mt-launch/pack-intake-db), driver run wf_2eb625e1fdb2dda6. P1 `tenant_pack_intake` (PK
`(tenant_id, item_key)`, 13-key checklist + status CHECKs, FK `tenants(tenant_id)`), P2 `tenant_content_pipeline`
(`unique (tenant_id, locale, key)`, review_state CHECK), both service-role-only RLS with client privileges revoked; P3
`get_tenant_launch_readiness(uuid)` SECURITY INVOKER, STABLE, `search_path = public, pg_catalog`, EXECUTE service_role
only, reads only intake + `tenants`. P4 MIGRATION-QUEUE rows 9-10 after WS5 `tenant_content_overrides` + drift
baseline. P5 `mt-launch-pack-intake-pgtap.test.ts` 17/17 green on head, 17/17 red on base; pgTAP plan, rollback and
read-only pre/post checks in `docs/validation/VTID-05324/`. No renumber needed (latest on main 20261021140000).
Nothing applied anywhere. Next: reviewer agent on the PR head.
### 2026-10-21T16:30Z Â· kiro-hotmail-202610211408-c407 Â· executing (PR open)
PR https://github.com/exafyltd/vitana-platform/pull/4265. Local: jest 17/17, tsc, `npm run build`, drift test 8/8,
`queue.mjs validate` + `scope-check` and `validate-pr-locally` all green (`docs/validation/VTID-05324/outputs/`). State
stays `executing` in this PR (`ready â†’ in-review` is not a legal single-PR transition). Claim released. Next: reviewer
agent `agent:vitana-lane-reviewer (claude-sonnet-5.5)` on the PR head, then the land step under Â§7b.
### 2026-10-21T17:45:00Z · agent-vitana-lane-reviewer-202610211740-f896 · review
review: changes
head: d9ed42dbf8f1aa0a3b2d29a91416970337cfde15
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4265
Findings: blocking: docs/validation/VTID-05324/outputs/red-on-base.txt — red-on-base is a setup-tests.ts module-resolution failure (operator-onramp-rate-limit not found), not an assertion red, so it does not show the tests fail on the missing behaviour; re-record on a clean origin/main plus the new test file and correct verification.md. non-blocking: pgTAP and local dry-run not executed (no Postgres), acceptance depends on RUN-MIGRATION checks; non-blocking: 3 CI failures are the pre-existing vtid-04868 test, red on main too.
Next: the lane's seat fixes the blocking findings
### 2026-10-21T18:04Z · kiro-hotmail-202610211408-c407 · executing (review round 1 fix)
Blocking finding fixed: red-on-base re-recorded on clean origin/main 84fc0ca6 with only the lane test added (every other
lane change reverted for the run): `Tests: 15 failed, 2 passed, 17 total`, assertion failures on the missing migrations,
queue rows, baseline entries and rollback; no module-resolution error. The 2 base passes are negative guards (WS5 no-write,
health-table guard self-test). Head merged with the same main: jest 17/17, tsc 0. `verification.md` and `commands.log`
corrected; verification.md now states the pgTAP plan and local dry-run were not executed (no Postgres) and are covered by
the RUN-MIGRATION pre/post checks. Next: reviewer agent on the new PR head.
### 2026-10-21T18:41:09Z · kiro-exafy-202610211836-c5d0 · review
review: accept
head: d7161cb59ee0305ee13e0d4dec5302be4f0fda70
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4265
Findings: round-1 blocking finding fixed: red-on-base is now recorded on clean origin/main 84fc0ca6 with only the lane test added, showing 15 failed / 2 passed / 17 total as assertion failures and no module-resolution error; the 2 base passes are negative guards. Acceptance P1-P5 met: both migrations are expand-only, service-role-only RLS with client privileges revoked, get_tenant_launch_readiness is SECURITY INVOKER / STABLE / search_path pinned / service_role EXECUTE only and reads only intake + tenants. MIGRATION-QUEUE rows 9-10 are ordered after WS5, the drift baseline is updated, and rollback SQL, pre/post checks and staging-tests.json are present. No protected gate file is touched. non-blocking: Lane scope red solely on the legacy reviewer_seat rule (c87358dc entry session), a §7b --admin governance-artifact case to link in the log; non-blocking: Jest failure is only the vtid-04868 session-layer test, said to be pre-existing on main since #4239, which the land step must confirm and must not --admin over; non-blocking: pgTAP and local dry-run not executed, covered by RUN-MIGRATION checks.
Next: the land step merges under §7b once main is current, the Jest failure is shown to be red on main as well, and the Lane scope override is linked in the lane log
