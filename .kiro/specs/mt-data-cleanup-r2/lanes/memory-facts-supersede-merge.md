---
lane: memory-facts-supersede-merge
state: ready
next_actor: kiro
depends_on: [orphan-analysis-and-quarantine]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102041*.sql
  - supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-01T15:30Z
repos: [exafyltd/vitana-platform]
---
# Supersede-merge reassigned memory_facts — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (authoritative) and the `memory-facts-supersede-merge` group of
`tasks.md` (tasks M1–M5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

Depends on `orphan-analysis-and-quarantine` (its reassignment must land first, so duplicate `(user_id, key)` facts
exist to merge).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` (RUN-MIGRATION checks). A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup-r2/memory-facts-supersede-merge`; PR title
`VTID-xxxxx (mt-data-cleanup-r2/memory-facts-supersede-merge): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-data-cleanup-r2/memory-facts-supersede-merge`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-data-cleanup/memory-facts-supersede-merge`. Versions day-shifted to `20261102*`; WS1 dependency named `mt-identity-r2`;
executor and reviewer on today's §3a/§7 rules.
