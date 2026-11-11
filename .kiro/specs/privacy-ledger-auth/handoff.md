---
slug: privacy-ledger-auth
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-11T11:16Z
sparring_record: .kiro/specs/privacy-ledger-auth/sparring/verdict.md
vtids: [VTID-05699, VTID-05700]
---
# Handoff — privacy-ledger-auth

Plan: `plan.md`. Tasks: `tasks.md`. Two lanes in vitana-platform: `areas-emails` (executor kiro, seat exafyltd) and
`ledger-auth-enforce` (executor claude, protected gate file). Not a lane: `history-rewrite-proposal.md`, which nothing in
this plan runs.

## Log

### 2026-11-11T11:40Z · kiro-exafyltd-202611111044-8f1d · drafted
Owner instructions of 2026-11-11 (items 4 and 5, and the history-rewrite proposal), quoted in `plan.md`. Pushed as a
`plan(` PR for PLAN-SPAR. No VTID before convergence; CI allocates them.

Decisions taken:
1. The production switch is a repository variable with default `log`, not a hardcoded `enforce`: the owner asked that the
   flip be the owner's own command, and with a variable merging changes nothing in production. The workflow has no free
   input (25 of 25).
2. The staging probe targets the completion route with a VTID that does not exist, never the allocate route, so a staging
   gateway that lost its pin still writes nothing.
3. `areas-emails` changes only `areas.yaml`, the scope the owner named. The other files that hold the addresses are
   counted and listed by command in the proposal (step 0) and are cleaned in later lanes.
4. Both lanes have no `depends_on`. Lane `seats` of `agentic-delivery-v2` waits for `areas-emails` (same file).

### 2026-11-11T11:16Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 2 lane(s) got a VTID and are handed to Kiro.
