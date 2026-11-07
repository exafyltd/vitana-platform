---
lane: health-home-tenant-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102130000_*.sql
  - supabase/migrations/20261102130100_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - services/gateway/test/mt-native-health/health-home-tenant.pgtap.sql
updated: 2026-11-07T14:17Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05595
---
# Frozen health home tenant (DB) — mt-native-health-r2/health-home-tenant-db (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health-r2/plan.md` (authoritative) and the `health-home-tenant-db` group of `tasks.md`
(tasks H1–H4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes — **a database change is a
migration file in this PR; Kiro applies it via RUN-MIGRATION after merge, only on the owner's approval of the files and the target database (§7d).** Work only inside the allowed paths.
Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`, `rollback.sql`,
`live-before.sql`/`post-apply-checks.sql`.

Depends on mt-identity-r2's membership unification (canonical `user_tenants.is_primary`): the MIGRATION-QUEUE row sorts
AFTER those rows; cite them when you add the row.

Branch `kiro/mt-native-health-r2/health-home-tenant-db`; PR title
`VTID-xxxxx (mt-native-health-r2/health-home-tenant-db): …`; commit trailers `Collab-Session: <your kiro session id>`
and `Collab-Lane: mt-native-health-r2/health-home-tenant-db`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (the reviewer seat `jtadic` picks it up), `pr: <url>`, append a log entry, release the claim.

`docs/MULTI-TENANT-PLAN.md` is hash-locked: this lane never edits it. The backfill migration opens with a `RAISE EXCEPTION` guard (round-1 F6) that aborts unless every member has exactly one
primary `user_tenants` row, so it never freezes a wrong home tenant if mt-identity-r2's membership unification has not
run yet.

## Log
### 2026-11-01T15:37Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-native-health/health-home-tenant-db`. Versions day-shifted to `20261102130*`. Executor and reviewer follow today's §3a/§7 rules.

### 2026-11-07T14:17Z · ci-plan-spar · ready (VTID allocated)
VTID-05595 allocated after policy approval (converged-auto-v1).

### 2026-11-07T16:05:00Z · agent-vitana-lane-reviewer-202611071604-adc6 · review
review: accept
head: 09077fac059840d439bdac8a4d63cee01bce6ebf
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4811
Findings: non-blocking: .kiro/specs/mt-native-health-r2/tasks.md pgTAP path says mt-native-health-r2/ but lane paths use mt-native-health/ (lane file governs, noted in acceptance); non-blocking: lane file state still ready on the branch (land step sets state); non-blocking: pgtap-red-no-migrations.txt header carries a local worktree path; non-blocking: apply needs owner approval (§7d) and rows 14-16 first (guard enforces it)
Next: the land step merges under §7b
