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
updated: 2026-11-06T10:09Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05570
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

### 2026-11-06T10:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05570 allocated after policy approval (converged-auto-v1).

### 2026-11-07T14:30:00Z · agent-vitana-lane-reviewer-202611071422-3202 · review
review: accept
head: 1748b72a05096ae2a7371cae773f4db72b22a907
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4799
Findings: non-blocking: MIGRATION-QUEUE note says "row 36 apply", should be row 39 (stale after renumber); non-blocking: group key (tenant,user,fact_key,entity) narrower than "(user_id,key)" in the spec, matches write_fact, list under Decisions taken; non-blocking: late rollback could re-currentize a winner that write_fact superseded after the merge; non-blocking: run file's post-assert not covered by pgTAP; non-blocking: CI on this head not verifiable by the reviewer, caller reports all green
Next: the land step merges under §7b (accept on the current head, all checks green on it, up to date with main); nothing is applied, migrations 37-39 still need owner approval under §7d
