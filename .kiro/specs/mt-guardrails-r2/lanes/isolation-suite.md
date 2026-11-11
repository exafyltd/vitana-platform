---
lane: isolation-suite
state: done
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: [local-test-stack-pglite, generated-inventories]
paths:
  - scripts/ci/sql-tests/mt-isolation.test.sql
  - scripts/ci/sql-tests/run-mt-isolation-test.sh
updated: 2026-11-08T16:48Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05446
---
# Isolation suite (pgTAP) — mt-guardrails-r2/isolation-suite (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `isolation-suite` section of
`tasks.md` (P1—P3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
VTIDs come from PLAN-SPAR on convergence; never by hand. Depends on
`local-test-stack` (the suite runs against its seeded, running local stack — the pinned
`supabase/postgres` image that ships `pgtap`, plus the pinned `pg_prove`, R2-F1) and
`generated-inventories` (for the shared health-table-list constant).
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The suite only ever
touches the local stack — it is read-only against production by construction (rules 31/48). It uses
**pgTAP**, which the hash-stamped parent program plan mandates for exactly these assertions
(`docs/MULTI-TENANT-PLAN.md` §4.2 at `:51` and §4.9 at `:61`; parent plan-body hash
`869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326` at `:1`). This spec is the first
introduction of pgTAP into the repo — path (a) from sparring round 1; the parent already assumed WS0
would introduce it, so no parent amendment is made (R1-F2). The runner invokes `pg_prove` over
**external `psql`** against lane 1's running stack (NOT `initdb`/`pg_ctl`). Both the spec
(`scripts/ci/sql-tests/mt-isolation.test.sql`) and the runner
(`scripts/ci/sql-tests/run-mt-isolation-test.sh`) live in `scripts/ci/sql-tests/`, exactly as the
VTID-05149 analogue co-locates `vtid-05149-tenant-foundation.test.sql` with
`run-tenant-foundation-test.sh`, so `SQL-MT-ISOLATION.yml`'s `paths:` uses the `scripts/ci/sql-tests/**`
glob like `SQL-HEALTH-STORE.yml`/`SQL-MEMORY-SENSITIVITY.yml` (not `SQL-TENANT-FOUNDATION.yml`'s file list).
The runner MUST start with the PGHOST guard copied from `run-tenant-foundation-test.sh:18-20`
(`*supabase*|*amazonaws*|*rds*` → exit 2), runs under `set -euo pipefail`, and prints
`PASS mt-isolation` as its last line only after `pg_prove` exits 0 — the marker `ci-wiring`'s
`report-gate.mjs --expect '^PASS mt-isolation'` checks. For the health tables
use the shared health-table-list constant from `generated-inventories` (switching to mt-identity's
`isHealthTable()` when it ships), never a scattered local copy (CROSS-SPEC O1). Work only inside the
allowed paths; add this lane's own `docs/validation/<vtid>/`.
Branch `kiro/mt-guardrails-r2/isolation-suite`; PR title `VTID-xxxxx
(mt-guardrails-r2/isolation-suite): —`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails-r2/isolation-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).

### 2026-11-01T17:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05446 allocated after policy approval (converged-auto-v1).

### 2026-11-08T14:22Z · kiro-hotmail-202611061752-cc1f · ready (depends_on repointed)
`depends_on` changed from `local-test-stack` to `local-test-stack-pglite` (VTID-05520, done) per plan.md Amendment 2, decision 1 and its Consequences. `local-test-stack` (VTID-05447) and `local-test-stack-v2` (VTID-05469) are parked as superseded (PRs #4881, #4882). No other change.

### 2026-11-08T14:45:00Z · agent-vitana-lane-reviewer-202611081444-4bdc · review
review: accept
head: 319ef180b809ffc779ae0324e42e6e8e0a650517
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4900
Findings: none blocking. The diff against origin/main (origin/main...319ef180b8) is one file, .kiro/specs/mt-guardrails-r2/lanes/isolation-suite.md, with only three changes: depends_on [local-test-stack, generated-inventories] -> [local-test-stack-pglite, generated-inventories], the updated field, and one appended log entry citing plan.md Amendment 2 decision 1 and Consequences. Amendment 2 says the lane keeps depends_on local-test-stack, which now means local-test-stack-pglite. local-test-stack-pglite is state done (VTID-05520, merge 932da573be) on origin/main. Same change as #4901 (ci-wiring). No protected gate file, test, workflow or live system touched. Non-blocking: CI check results on this head could not be read by this role (gh statusCheckRollup and gh pr checks returned HTTP 400, GraphQL pass-through unsupported); land-guard checks must confirm every required check green on this head.
Next: the land step merges under §7b once land-guard confirms every check green on this head

Collab-Session: agent-vitana-lane-reviewer-202611081444-4bdc
Collab-Review: mt-guardrails-r2/isolation-suite
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
Collab-Reviewed-Head: 319ef180b809ffc779ae0324e42e6e8e0a650517

### 2026-11-08T16:40:00Z · agent-vitana-lane-reviewer-202611081638-b3fc · review
review: accept
head: 30954a949f10e6392b86b52c1ef04d132579e6ab
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4912
Findings: Round-1 blocking findings fixed. Runner is strict by default with no env override (exit 1, no PASS over 14 unverified claims). --report exits 0 and ends with "REPORT mt-isolation: ...", never PASS. ab_dual single-series assertion is not ok 58 by default and UNVERIFIED only in --report. Self-test, 8 mutations, red-before-fix evidence present; nothing else loosened; all 15 files inside lane paths; no protected gate file. Non-blocking: (1) the report-mode ab_dual line does not name 20251231000000_vtid_01103_health_compute_engine.sql (it is cited only in acceptance.md); (2) CI check runs not readable with reviewer tools, so land-guard must confirm green on this head; (3) the default run stays red until the 14 tables are replayable, as intended (Amendment 3 decision 3).
Next: the land step merges under §7b after land-guard.mjs checks are green and the PR is up to date with main

Collab-Session: agent-vitana-lane-reviewer-202611081638-b3fc
Collab-Review: mt-guardrails-r2/isolation-suite
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
Collab-Reviewed-Head: 30954a949f10e6392b86b52c1ef04d132579e6ab

### 2026-11-08T16:44Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-guardrails-r2/isolation-suite; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-08T16:44Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4912. Reviewed on head `30954a949f` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-08T16:44Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 2ea9ca18e72dcf8242a855b73e497f54347096f5 (exafyltd/vitana-platform#4912)
authority: §7b PM rule. Squash merge by land-guard; `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
Next: the `done` record.

### 2026-11-08T16:48Z · kiro-hotmail-202611061752-cc1f · verified → done
Deploys nothing. The lane is merged and every acceptance item holds. The default suite run stays red until the 14 unverified claims are replayable (Amendment 3 decision 3); that is the ci-wiring follow-up, not a defect of this lane.
