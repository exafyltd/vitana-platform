---
lane: fix
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/specs/loop-catalog-v1.json
  - services/gateway/src/services/operator-bootstrap-pack.ts
  - services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts
  - services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts
  - supabase/migrations/20261112100000_bridge_sparring_convergence_is_approval.sql
updated: 2026-11-12T21:28Z
vtid: VTID-05785
---

# Lane: fix (repo exafyltd/vitana-platform)

Four independent fixes for the four suites `#5021` and `#5027` broke on `main`: the loop catalog, the CLAUDE.md
Part 1 extract budget, the session-layer wording regex, and the migration's SECURITY DEFINER comment. Tasks in
`tasks.md`.

## Log
### 2026-11-12T20:55Z · kiro-exafyltd-202611122052-a6df · ready
Lane created with the plan.

### 2026-11-12T21:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05785 allocated after policy approval (converged-auto-v1).

### 2026-11-13T09:49Z · agent-vitana-lane-reviewer-202611131036-6701 · review
review: accept
head: 89a98a06724f64511ad60ab86e363900e43790a4
reviewer: exafyltd (exceptions seat, this lane's reviewer_seat `agent:vitana-lane-reviewer` unavailable in Kiro Web — the gateway's workspace-agent review step does not run here, so the exceptions seat ran the M4 Bedrock chain in its place) — model of record eu.anthropic.claude-opus-5-5 (tier 1, eu-central-1)
PR: https://github.com/exafyltd/vitana-platform/pull/5057
CI on this head: 28/28 required checks green (Kiro access drift (live, read-only) skipped, non-blocking); `validate` needed one re-run after an attempt-1 runner OOM in `tsc` on an earlier head (infra flake, collaboration.md §7a allowlist), re-run succeeded.
Findings: none blocking; all non-blocking:
- [non-blocking] `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts:45`: C3 departs from the converged plan text (plan.md C2/C3 specifies widening to `\w+ approval`; the head pins the literal `machine approval` instead, stricter not broader, declared in acceptance.md AC-3 and both fix commits). `plan.md` is outside this lane's `paths`; a follow-up should update it so plan and code agree.
- [non-blocking] `docs/validation/VTID-05785/outputs/red.txt`: captured against an earlier `origin/main`, not the current merge-base. The post-merge targeted re-run (4 suites, 0 failed) and the C1/C3/C4 mutation re-verification at the final head stand in for an exact re-capture.
- [non-blocking] `docs/validation/VTID-05785/outputs/full-suite.txt`: captured on the post-round-1 head, not the final head (round 2 changed one regex line plus evidence files only); CI's 4 Gateway Jest shards are green on the final head.
- [non-blocking] `services/gateway/src/services/operator-bootstrap-pack.ts:59`: `rulesChars` 8_000→12_000 stays inside `PACK_MAX_CHARS` 40_000; worth a staging check that the other pack sections aren't clipped.
- [non-blocking] `services/gateway/specs/loop-catalog-v1.json:381`: duplicates open PR #5050's identical hunk per the plan's own noted risk; whichever of the two lands second must drop or rebase this hunk.
- [non-blocking] `docs/validation/VTID-05785/commands.log`: carried stale "CI not yet confirmed" wording from an earlier round; superseded by this entry's CI line, confirmed directly via `gh api .../check-runs` and `land-guard.mjs checks` on this exact head immediately before this review ran.
Earlier rounds on this lane, same PR: review round 1 (head eb254e66d8) found 2 blocking (C1 mutation not credible
— a Python mutation script mis-indexed the catalog and never edited it; C3's sparring-accepted `\w+ approval`
wildcard judged a loosened assertion), fixed in 81c13c9748. Round 2, first pass (head 00166adeb5) wrongly saw
~150 foreign files and 3 blocking findings because it diffed against a stale base instead of the merge-base with
`origin/main`; re-run with the correct merge-base (4e215b0198) found only 1 real blocking item left (C3's 3-word
allowed set still judged loosened versus the base test's single literal), fixed in 6541a21823 by pinning the
literal `machine approval` with no alternation — accepted on that head. A further clean merge of `origin/main`
(89a98a0672) brought in `.github/workflows/RUN-MIGRATION.yml`/`STAGING-MIGRATE.yml`, which collaboration.md §3
treats as invalidating the prior accept; re-reviewed on 89a98a0672 (this entry) with zero blocking findings.
