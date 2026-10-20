---
lane: local-test-stack
state: ready
next_actor: owner
executor: kiro
seat: hotmail
reviewer_seat: exafy
depends_on: []
paths:
  - supabase/tests/fixtures/**
  - supabase/tests/local-stack/**
  - scripts/mt/stack/**
  - docs/multitenancy/LOCAL-STACK.md
updated: 2026-10-20T08:30Z
---
# D11 local Supabase stack + fixtures — mt-guardrails/local-test-stack (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `local-test-stack` section of
`tasks.md` (T1–T5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
`next_actor: owner` is a HELD state: it flips to `kiro` automatically when PLAN-SPAR allocates this
lane's VTID after the plan converges. Do not start before then.
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes against any live
system. The schema snapshot comes from a `pg_dump --schema=public --schema-only` dump (structure only, never
data; the regenerate script refuses any other schema — `auth`/`storage`/`realtime` are pre-installed by
`supabase/postgres` and never re-created); fixtures INSERT into the existing `auth.users`, never
`CREATE` it (do not copy `vtid-05149-tenant-foundation.test.sql:13`, written for `postgres:16`); fixtures are
synthetic (D11/D13). This lane brings up Postgres from `supabase/postgres:17.4.1.074` (index digest
`sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670`; ships `pgtap`, stock
`postgres:16` does not) and runs `pg_prove` from `libtap-parser-sourcehandler-pgtap-perl=3.36-2` inside
an `ubuntu:24.04` container — the plan's "Pinned versions" table, which `ci-wiring` copies verbatim, so
local and CI never diverge. pgTAP is required by the
hash-stamped parent plan §4.2/§4.9 (R1-F2) and is first introduced into the repo here, so the
`isolation-suite` lane can run its pgTAP assertions against this running stack over external `psql`.
Record the pinned image tag and apt version. Work only inside the allowed paths. Add this lane's own
`docs/validation/<vtid>/` (plan copy, `scope.json`, `staging-tests.json`).
Branch `kiro/mt-guardrails/local-test-stack`; PR title `VTID-xxxxx (mt-guardrails/local-test-stack): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane:
mt-guardrails/local-test-stack`. When the PR is open: set `state: in-review`, `next_actor: kiro`,
`pr: <url>`, append a log entry, release the claim.
Escalation carry-over (owner approved escalated, 2026-10-20) — R3-F2 and R3-F3, tasks T1a and T4a in `tasks.md`.
Acceptance (R3-F2): `LOCAL-STACK.md` and the regenerate script's header state that the `pg_dump --schema=public
--schema-only` is a single, manual, read-only step run once by a seated engineer on a workstation (never CI, never
the local stack at runtime), the only sanctioned production connection; "no production access" covers the local
stack and every CI workflow, and none of them invokes `pg_dump` or a live endpoint. Acceptance (R3-F3): beside the
pins, `LOCAL-STACK.md` records that `17.4.1.074` is the version the 2026-08-28 security-advisor audit flags as
vulnerable (patches outstanding), pinned only for production-parity determinism of the throwaway stack; the digest
guard does not cover upstream vulnerabilities; bumping the pin table is the upgrade path.
## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. First lane of the chain: `generated-inventories` and `isolation-suite`
depend on the stack + fixtures this lane commits. Held at `next_actor: owner` until PLAN-SPAR allocates
the VTID.
### 2026-10-18T16:20Z · kiro-hotmail-202610151618-b437 · spar round-1 (fresh session e7f1e151) → installs pgTAP
R1-F2 (accepted): the parent plan §4.2/§4.9 mandates pgTAP for the isolation assertions, so this lane
now installs the `pgtap` extension + `pg_prove` into the local stack (first introduction into the repo,
path (a) — no parent amendment) and pins their versions for CI parity. The `isolation-suite` lane runs
pgTAP against this running stack over external `psql` (R1-F1).
### 2026-10-18T18:40Z · kiro-hotmail-202610151618-b437 · spar round-2 → concrete pinned install
R2-F1 (accepted): named the one concrete, pinned install mechanism this lane and `ci-wiring` share
verbatim — the `supabase/postgres` image pinned by exact tag (ships `pgtap`; stock `postgres:16` does
not) for the server, and `pg_prove` from a pinned `libtap-parser-sourcehandler-pgtap-perl` apt version
on the host — so the "same versions across local and CI" determinism guarantee is now verifiable. T4
updated accordingly; `paths` unchanged.
### 2026-10-19T18:00Z · kiro-hotmail-202610151618-b437 · spar round-1 (session 496d49e4) → public-only dump
R1-F1 (accepted): the dump is scoped to `--schema=public` and enforced by the regenerate script; fixtures
INSERT into the image's pre-installed `auth.users`; the smoke test asserts `auth.users` pre-exists. T1/T2/T5
updated; `paths` unchanged.
### 2026-10-19T20:20Z · kiro-hotmail-202610151618-b437 · spar round-2 (session 496d49e4) → concrete pins
R2-F1 (accepted): the pins are now literal values — `supabase/postgres:17.4.1.074` (production's version) +
its index digest, `libtap-parser-sourcehandler-pgtap-perl=3.36-2` (noble), `ubuntu:24.04`. T4 updated; `paths` unchanged.
