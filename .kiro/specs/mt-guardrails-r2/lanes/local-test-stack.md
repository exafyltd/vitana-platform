---
lane: local-test-stack
state: ready
next_actor: kiro
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/tests/fixtures/**
  - supabase/tests/local-stack/**
  - scripts/mt/stack/**
  - docs/multitenancy/LOCAL-STACK.md
updated: 2026-11-02T19:17Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05447
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

### 2026-11-01T17:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05447 allocated after policy approval (converged-auto-v1).
### 2026-11-01T21:40Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T21:46Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T21:52Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T21:58Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:04Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:10Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:16Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:22Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:42Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T22:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:06Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:12Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:24Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:42Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-01T23:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:06Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:12Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:24Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:42Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T00:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:06Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:12Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:24Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:44Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:50Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T01:56Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:02Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:08Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:14Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:20Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:26Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:44Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:50Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T02:56Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:02Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:08Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:14Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:20Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:26Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:46Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:52Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T03:58Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:04Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:10Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:16Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:22Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:28Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:46Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:52Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T04:58Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:04Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:10Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:16Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:22Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:28Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T05:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:06Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:12Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:24Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:30Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T06:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:06Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:12Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:24Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:48Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T07:54Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:00Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:06Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:12Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:18Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:24Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:47Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:53Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T08:59Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:05Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:11Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:17Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:23Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:29Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:47Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:53Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T09:59Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T10:05Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T10:11Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T10:17Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T10:23Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T10:29Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T10:49Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T14:19Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T14:25Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T14:49Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T14:55Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:01Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:07Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:13Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:19Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:25Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:51Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T15:57Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T16:03Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T17:09Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T17:15Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T17:21Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T17:27Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T17:51Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T17:57Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:03Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:09Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:15Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:21Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:27Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:53Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T18:59Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T19:05Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T19:11Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
### 2026-11-02T19:17Z · pm-agent · update
reassign lane hotmail→exafyltd (stale_ready, Claude unavailable)
