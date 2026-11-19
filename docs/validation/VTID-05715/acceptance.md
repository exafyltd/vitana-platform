# VTID-05715 — kiro-fleet-register, lane `seats`

Plan: `.kiro/specs/kiro-fleet-register/plan.md` (#5001, merged `f2df5d6c32`).

## What changed
`docs/programs/areas.yaml` `seats:`: `kiro: <slot>` on the four existing seats (hotmail 1, exafy 2, exafyltd 3,
jtadic 12); five new seats `vitanaland` (4), `office` (5), `support` (6), `admin` (7), `tasks` (8) with
`surface: pending`, no `automation`, no `account`; a comment block inside `seats:` defining account, seat, operator
and session, and reserving slots 9-11. No email address, no automation file, no area, no permission changed.

## Acceptance criteria → tests

AC-1 `loadSeats` returns exactly the nine seats and agrees with the line parse; no seat renamed or removed.
TEST: docs/validation/VTID-05715/areas-seats.test.mjs ("loadSeats returns the nine seats, none renamed or removed"; "loadSeats at HEAD agrees with the line parse")

AC-2 Every seat line is one-line `{ … }`, has `kiro:` with the values 1-8 and 12 each once, and no `account`.
TEST: docs/validation/VTID-05715/areas-seats.test.mjs ("every seat line is one-line { … }, carries kiro: <slot>, and no account")
TEST: scripts/collab/areas-no-email.test.mjs (no email address in the seat file)

AC-3 The five new seats are `surface: pending` with no automation; the existing automation rules still hold.
TEST: docs/validation/VTID-05715/areas-seats.test.mjs ("the five new seats are pending and have no automation")
TEST: scripts/collab/automations.test.mjs, scripts/collab/queue.test.mjs

Red on base: `outputs/red-on-base.txt` (3 fail). Green: `outputs/green.txt`.

## Decisions taken
- The evidence test lives in `docs/validation/VTID-05715/` because the lane's paths are the seat file and evidence only.
- Slot 12 = seat `jtadic` is the converged plan's mapping; the owner roster of 2026-11-11 does not name Kiro 12, so the
  fleet inventory marks it "owner to confirm".

Not verified on staging: this lane deploys nothing (no gateway, frontend or database change), so it has no staging manifest; the tests above prove it.
