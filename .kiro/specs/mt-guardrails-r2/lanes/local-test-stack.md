---
lane: local-test-stack
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/tests/fixtures/**
  - supabase/tests/local-stack/**
  - scripts/mt/stack/**
  - docs/multitenancy/LOCAL-STACK.md
updated: 2026-11-01T15:30Z
repos: [exafyltd/vitana-platform]
---
# D11 local Supabase stack + fixtures — mt-guardrails-r2/local-test-stack (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `local-test-stack` section of
`tasks.md` (T1–T5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
VTIDs come from PLAN-SPAR on convergence; never by hand.
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no merge
outside §7b, no Supabase or AWS writes, no connection to any live system. The schema comes from a local replay of
`supabase/migrations/*.sql` in timestamp order (`scripts/mt/stack/replay.sh`) on the pinned image, with the committed
skip-list `supabase/tests/local-stack/replay-skip.json`; there is no production dump (re-plan R3-F2). Task T0 is the
boot-and-replay spike (re-plan R3-F1): if the required tables do not exist after the replay, stop and raise it.
`scripts/mt/stack/up.sh` starts `supabase/postgres:17.4.1.074` (digest
`sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670`) with `docker run` and waits on
`pg_isready`; `ci-wiring` calls the same script, so local and CI never diverge. Fixtures INSERT into the existing
`auth.users`, never `CREATE` it; fixtures are synthetic (D11/D13). `pg_prove` comes from
`libtap-parser-sourcehandler-pgtap-perl=3.36-2` in an `ubuntu:24.04` container. Work only inside the allowed paths;
add this lane's own `docs/validation/<vtid>/` (`scope.json`, `staging-tests.json`).
Branch `kiro/mt-guardrails-r2/local-test-stack`; PR title `VTID-xxxxx (mt-guardrails-r2/local-test-stack): …`;
trailers `Collab-Session` and `Collab-Lane: mt-guardrails-r2/local-test-stack`.
Acceptance (R3-F2): `LOCAL-STACK.md` states the replay is the only schema source and no lane connects to a live
system. Acceptance (R3-F3): beside the pins, `LOCAL-STACK.md` records the `vulnerable_postgres_version` caveat.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).
