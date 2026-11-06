---
slug: live-room-recurrence
author: claude
author_seat: none
executor: kiro
next_actor: claude
state: drafted
updated: 2026-11-06T08:45Z
---
# Handoff — live-room-recurrence

Plan: `plan.md`. Three lanes in serial `depends_on` order, two repos' worth of work across two repos, as in
`live-room-edit-cohost`:
- `db-live-series` (repo `exafyltd/vitana-platform`, executor kiro, seat exafy): series table and columns.
- `gateway-live-series` (repo `exafyltd/vitana-platform`, executor kiro, seat exafy): create, edit scope, cancel, rolling window.
- `v1-live-series` (repo `exafyltd/vitana-v1`, executor kiro, seat exafyltd): the Repeat control and the edit scope prompt.

Owner stop to expect: applying the migration `20261106120000_live_room_series.sql` needs the owner's approval (`collaboration.md` §7d).
Sparring: CI PLAN-SPAR on this `plan(` PR. Converged plans are approved by policy (`converged-auto-v1`); VTIDs come from CI, not by hand.

## External prerequisites
No lane of this plan is claimed until `live-room-edit-cohost` lanes `gateway-cohost` and `v1-edit-session` are `done` (see plan.md).

## Log
### 2026-11-06T08:45Z · claude-code session_01Cp885FGVuZp27dQmDP6eMH · drafted
Written on the owner's instruction (6 Nov 2026) for repeating Live Rooms. Read on origin/main 84a488d282: the
`live_room_sessions` table has no series field; calendar entries already use `calendar_events.rrule` with the gateway
expander in `services/calendar-recurrence.ts`, which this plan reuses. Depends on the in-flight `live-room-edit-cohost`
lanes (`gateway-cohost`, `v1-edit-session`) for the shared form, the edit dialog and `live.ts`. No lane is claimed.
