---
lane: orphan-analysis-and-quarantine
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102040*.sql
  - supabase/tests/vtid_mt_data_cleanup_orphan_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-07T12:55Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05571
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-data-cleanup-r2/orphan-analysis-and-quarantine
pr: https://github.com/exafyltd/vitana-platform/pull/4773
---
# Orphan analysis, snapshot, remap and quarantine — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (authoritative) and the `orphan-analysis-and-quarantine` group of
`tasks.md` (tasks O1–O9; O8 repoints the NULL-fallback writers of six migrations, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

This lane is the foundation of the DB lanes (2–4 depend on it). R3-F1: bot-sent rows with a real tenant are untouched;
bot-sent rows with `tenant_id = …0001` go to quarantine (`bot_sender_dev_tenant`), never recipient-derived; ship the
re-pollution check (`plan.md` Re-plan answers).

**Cross-spec dependency:** reads the canonical `user_tenants` produced by **mt-identity-r2 `membership-unification`**.
That is NOT in this lane's `depends_on:` (which lists only lanes of this spec); do not start until it is done. The
forward migration's post-check asserts the canonical membership source is present.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
the analysis/pre/post-check SQL is delivered under `docs/validation/<vtid>/` (RUN-MIGRATION checks) to run via `RUN-MIGRATION.yml`.
A database change is a migration file in this PR. Work only inside the allowed paths; the lane adds its own
`docs/validation/<vtid>/` (plan-sparring.md copy, scope.json, staging-tests.json) in the same PR.

Branch `kiro/mt-data-cleanup-r2/orphan-analysis-and-quarantine`; PR title
`VTID-xxxxx (mt-data-cleanup-r2/orphan-analysis-and-quarantine): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-data-cleanup-r2/orphan-analysis-and-quarantine`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-data-cleanup/orphan-analysis-and-quarantine`. Versions day-shifted to `20261102*`; WS1 dependency named `mt-identity-r2`;
executor and reviewer on today's §3a/§7 rules.

### 2026-11-06T10:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05571 allocated after policy approval (converged-auto-v1).

### 2026-11-07T12:27Z · agent-vitana-lane-reviewer-202611071142-ef92 · review
review: accept
head: 1d68213b02aa5d4325ff34f6a3c1fb8fc4f5ffe6
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4773
Findings:
- All three earlier findings resolved. The NULL peer is handled via `t.<peer> IS NOT NULL`.
- The harness matches production and pgTAP C6 is added (plan 50). Red was 4 not ok on 16d19fe8c3, green 50/50.
- All 33 files are in scope, no weakening, no live write, no protected file.
- non-blocking: CI was not readable by the reviewer; the land step confirms it.
- non-blocking: the migrations need owner approval per file and database (collaboration.md §7d).
Next: land under §7b

### 2026-11-07T12:45:00Z · agent-vitana-lane-reviewer-202611071241-ff8c · review
review: accept
head: d38b8b47dd0122244ec0bd01992b36734085fb35
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4773
Findings: non-blocking: drift-baseline sort order/uniqueness/count checked by diff reading, not by script (node denied in the review sandbox); non-blocking: CI (11/11 success on this head) taken from the caller's REST read, not my own query
Next: the land step merges under §7b

### 2026-11-07T12:50Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-data-cleanup-r2/orphan-analysis-and-quarantine; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T12:50Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4773. Reviewed on head `d38b8b47dd` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T12:50Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 97eeca91487bd81c3682545eca3d4fba35bc23c3 (exafyltd/vitana-platform#4773)
authority: §7b PM rule. Squash merge by land-guard on head `05875cee56`: the reviewed head `d38b8b47dd` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T12:55Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record: merge 97eeca91487bd81c3682545eca3d4fba35bc23c3 (#4773) changes no path under services/gateway or the stage deploy workflow (supabase migrations, tests, docs and the drift baseline only), so AWS-STAGE-DEPLOY-GATEWAY and STAGING-VERIFY did not run for it: this change deploys nothing. It is done at merge with green checks (12/12 on the final head). The migrations 20261102040000 to 20261102040400 are on main and NOT applied; applying them needs the owner's approval per file and database (collaboration.md §7d). The lane claim is released once this record is on main.
