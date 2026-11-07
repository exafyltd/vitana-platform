---
lane: kb-overlay-db
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql
  - supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql
  - scripts/ci/migration-drift-baseline.json
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-07T16:45Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05498
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-packs-r2/kb-overlay-db
pr: https://github.com/exafyltd/vitana-platform/pull/4795
---
# kb-overlay-db — knowledge_docs tenant overlay column (repo vitana-platform)

Plan: `.kiro/specs/mt-packs-r2/plan.md` (authoritative) and the `kb-overlay-db` section of `tasks.md` (D1–D3,
allowed paths, acceptance). Design + successor rules: `design.md`.

Expand-only migration `20261102080000_mt_packs_knowledge_docs_tenant_id.sql`: add nullable
`knowledge_docs.tenant_id uuid REFERENCES tenants(id)` (overlay/context; NULL = platform baseline), no backfill,
no NOT NULL; `SET lock_timeout` + retries. pgTAP spec `supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql`.
Add the not-yet-live column to `scripts/ci/migration-drift-baseline.json` and a MIGRATION-QUEUE row (NN=08 range
`20261102080000`–`085959`, after mt-tenant-admin P2/P3/C3 + moderator-tenant-scope; independent, expand-only).
This lane adds its own `docs/validation/<vtid>/` (plan-sparring.md copy, scope.json, staging-tests.json,
rollback.sql — the rollback drops the column). **The apply (RUN-MIGRATION) and the baseline removal are done by
Kiro after merge, only on the owner's approval of the files and the target database (§7d), not in this lane's PR** — a
DB change is a migration file in the PR (collaboration §7a).

**pgTAP harness is owned by mt-guardrails-r2 (cross-spec dependency, reference).** The pgTAP spec is placed under
`supabase/tests/mt/**` — the directory mt-guardrails-r2' `pgtap-isolation-suite` runner `scripts/mt/pgtap/run.*`
scans, and the one its `ci-wiring` C3 installs `pg_prove`/`pgtap` for. This lane does NOT create a runner or a
second test directory; it relies on mt-guardrails-r2 providing the harness (`pgtap-isolation-suite` for the runner,
`ci-wiring` for the CI `pg_prove` install). The `depends_on` field only takes in-spec lane ids, so this cross-spec
dependency is stated here and in `plan.md` ## Depends on rather than as a `depends_on` entry.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, **no `apply_migration` or any Supabase/AWS write** — the migration is a
file only. Work only inside the allowed paths. Branch `kiro/mt-packs-r2/kb-overlay-db`; PR title
`VTID-xxxxx (mt-packs-r2/kb-overlay-db): …`; trailers `Collab-Session: <id>` / `Collab-Lane: mt-packs-r2/kb-overlay-db`.
When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/kb-overlay-db`. Version day-shifted to `20261102080000`.

### 2026-11-02T16:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05498 allocated after policy approval (converged-auto-v1).

### 2026-11-07T13:55Z · agent-vitana-lane-reviewer-202611071352-7f28 · review
review: accept
head: 40789ca58dccc87f4d1844cf129d9ad7ed82d3b6
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4795
Findings: non-blocking: branch behind origin/main a5d793aa, queue file changed upstream, so a further merge may conflict on row 37; static test de-scoping judged correct, not a weakening, with a duplicated assertion line; pgTAP case 7 column list to be checked against the live schema at apply; baseline-independence and "Before the first overlay write" verified in the evidence and acceptance.md; CI not independently verified (GraphQL and gh api denied), caller reports green with five cancelled runs each beside a successful same-name run.
Next: the land step merges under §7b after bringing the branch up to date with latest main and confirming every check on that head; a hand-resolved conflict there needs a fresh review.

### 2026-11-07T16:05:00Z · agent-vitana-lane-reviewer-202611071603-0524 · review
review: accept
head: 158ac7e7aa4f2c7180b2781c6256779541605f05
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4795
Findings: non-blocking: known_missing_tables length not counted by hand (shell denied); the green drift check covers it. Otherwise none.
Next: the land step merges under §7b

### 2026-11-07T16:35:00Z · agent-vitana-lane-reviewer-202611071633-fb98 · review
review: accept
head: 744f3b7e6c2df540503107a5c8a4f52cd57b1f49
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4795
Findings: non-blocking: CI not independently verified by the reviewer, caller reports 12/12 green; row 40 note on version ordering and apply order is accurate. Otherwise none. Verified: the hand-resolved merge of origin/main 9ab419f9d1 changed only MIGRATION-QUEUE.md; origin/main...HEAD adds only row 40 and its note there (rows 1-39 untouched, no renumbering); the lane's own files are unchanged since 158ac7e7aa apart from the lane-log entry; nothing applied.
Next: the land step merges under §7b after confirming every check is green on this head and the branch is up to date with latest main

### 2026-11-07T16:42Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-packs-r2/kb-overlay-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T16:42Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4795. Reviewed on head `744f3b7e6c` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T16:42Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: f65570b63726b8f71f36710e6a45f810934c9028 (exafyltd/vitana-platform#4795)
authority: §7b PM rule. Squash merge by land-guard on head `2ac9545573`: the reviewed head `744f3b7e6c` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T16:45Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record: merge f65570b63726b8f71f36710e6a45f810934c9028 (#4795) changes no path under services/gateway or the stage deploy workflow (supabase migrations, tests, docs and the drift baseline only), so AWS-STAGE-DEPLOY-GATEWAY and STAGING-VERIFY did not run for it: this change deploys nothing. It is done at merge with green checks (12/12 on the final head). The migration in this lane is on main and NOT applied; applying it needs the owner's approval per file and database (collaboration.md section 7d). The lane claim is released once this record is on main.
