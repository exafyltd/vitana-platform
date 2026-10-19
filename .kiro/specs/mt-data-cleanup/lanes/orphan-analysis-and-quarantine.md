---
lane: orphan-analysis-and-quarantine
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101040*.sql
  - supabase/tests/vtid_mt_data_cleanup_orphan_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-01T13:00Z
---
# Orphan analysis, snapshot, remap and quarantine — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup/plan.md` (authoritative) and the `orphan-analysis-and-quarantine` group of
`tasks.md` (tasks O1–O9; O8 repoints the NULL-fallback writers of six migrations, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; it then flips `next_actor` to kiro itself.
This lane is the foundation of the spec — the other three depend on it.

**Cross-spec dependency:** reads the canonical `user_tenants` produced by **mt-identity `membership-unification`**.
That is NOT in this lane's `depends_on:` (which lists only lanes of this spec); do not start until it is done. The
forward migration's post-check asserts the canonical membership source is present.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
the analysis/pre/post-check SQL is delivered under `docs/validation/<vtid>/` for Claude to run via `RUN-MIGRATION.yml`.
A database change is a migration file in this PR. Work only inside the allowed paths; the lane adds its own
`docs/validation/<vtid>/` (plan-sparring.md copy, scope.json, staging-tests.json) in the same PR.

Branch `kiro/mt-data-cleanup/orphan-analysis-and-quarantine`; PR title
`VTID-xxxxx (mt-data-cleanup/orphan-analysis-and-quarantine): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-data-cleanup/orphan-analysis-and-quarantine`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T13:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created with the spec shell (push-first). Held at `next_actor: owner` pending PLAN-SPAR VTID allocation. Premises in
`handoff.md`.
