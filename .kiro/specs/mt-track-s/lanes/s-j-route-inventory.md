---
lane: s-j-route-inventory
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
area: frontend
paths:
  - supabase/functions/linkedin-import/**
  - supabase/config.toml
  - src/lib/edge-functions-caller-identity.s4.test.ts
  - scripts/check-edge-function-auth.mjs
  - package.json
  - docs/validation/**
updated: 2026-10-15T20:10:00Z
---
# s-j-route-inventory — remove dead `linkedin-import`, add edge-function auth inventory test (repo vitana-v1)

Plan: `.kiro/specs/mt-track-s/plan.md` (authoritative, between the plan markers) and the `s-j-route-inventory` section
of `tasks.md`. Design and the rules you must follow: `design.md`.

**HELD.** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID on a converged plan; PLAN-SPAR then flips
`next_actor` to `kiro` and writes the `vtid`. Do not add a `vtid` field by hand.

This is the one open piece of Track S / S-J: everything else (S-A..S-M, WS10 a–d) is already live in production — see
`plan.md` ## Problem and `handoff.md`. Do not re-touch any shipped fix.

Scope: vitana-v1 code only. `paths` above are vitana-v1 paths and are identical to `tasks.md` "Allowed paths:". The
inventory gate is a standalone node script wired into `npm test` (the repo's convention — `package.json` `"test"` runs
`node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs && vitest run`; a vitest `.test.ts`
under `supabase/functions/**` would never be collected because `vitest.config.ts:19` `include` is `src/**/*.test.{ts,tsx}`),
so the lane touches `scripts/check-edge-function-auth.mjs` and `package.json`. Deleting `linkedin-import` also requires
two companion edits that the `paths` must cover so the deletion is complete and `npm test` stays green:
`supabase/config.toml` (remove the orphaned `[functions.linkedin-import]` block at `:72-74`) and the collected vitest
suite `src/lib/edge-functions-caller-identity.s4.test.ts` (drop `linkedin-import` from its four assertions — it reads
the gone file at `:77-88,:90-92,:107-110` and asserts the dir contains it at `:272`). Neither `package.json`,
`supabase/config.toml` nor that test file is a governance path, so `executor: kiro` stands. The spec folder itself lives
in vitana-platform (collaboration §2, cross-repo plan); the lane's PR is against vitana-v1. This lane adds its own
`docs/validation/<vtid>/` (copy of `plan-sparring.md`, `scope.json`, `staging-tests.json`).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, never call a write endpoint against any live system.
Work only inside `paths`. Before deleting `linkedin-import`, grep both repos for any consumer; if one exists, STOP, log
it and set `next_actor: claude`. Branch `kiro/mt-track-s/s-j-route-inventory`; PR title
`VTID-xxxxx (mt-track-s/s-j-route-inventory): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-track-s/s-j-route-inventory`. When the PR is open: set `state: in-review`, `next_actor: kiro` (the
reviewer seat `jtadic` picks it up), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T17:40:00Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created by the mt-track-s planner. Seat `exafyltd` (frontend catch-all per `docs/programs/areas.yaml`; no more
specific area covers `supabase/functions/**`), reviewer `jtadic` (≠ seat). Held at `next_actor: owner` pending PLAN-SPAR
VTID allocation. Work: delete the unused `linkedin-import` edge function (VTID-05049 flagged it) and add an
edge-function caller-auth inventory test; code-only, no migration.

### 2026-10-15T18:30:00Z · kiro-hotmail-202610151618-b437 · ready (internal-review fix)
Applied INTERNAL-REVIEW MEDIUM-2: the inventory gate is a node `scripts/check-edge-function-auth.mjs` wired into
`npm test`, not a vitest `.test.ts` under `supabase/functions/__tests__/` (which `vitest.config.ts` `include:
['src/**/*.test.{ts,tsx}']` would never collect). `paths` now cover the files the implementation actually changes —
`scripts/check-edge-function-auth.mjs` + `package.json` — and stay identical to `tasks.md` "Allowed paths:".
`package.json` is not a governance path, so `executor: kiro` is unchanged.

### 2026-10-15T20:10:00Z · kiro-hotmail-202610151618-b437 · ready (internal-review round 2 fix)
Applied INTERNAL-REVIEW round 2. MEDIUM-1: added `supabase/config.toml` to `paths` and a T2 step to remove its
orphaned `[functions.linkedin-import]` block (`:72-74`). Plus a HIGH gap this reviewer surfaced that round 1 missed:
deleting `linkedin-import` breaks the already-collected vitest suite `src/lib/edge-functions-caller-identity.s4.test.ts`
(it reads the gone file and asserts the functions dir contains it, at `:77-82,:90-93,:107-110,:198`). Added that test
file to `paths` and a T2a step to drop `linkedin-import` from its four assertions in the same PR, keeping
`social-media-import`/`fetch-user-context` coverage. LOW-1: dropped the non-GET staging invoke (the guard aborts it);
the CI gate + Vitest suite are the authoritative proof. `paths` stay identical to `tasks.md` "Allowed paths:"; none of
the added files is a governance path, so `executor: kiro` stands.
