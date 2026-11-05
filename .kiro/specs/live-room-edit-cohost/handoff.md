---
slug: live-room-edit-cohost
author: kiro
author_seat: jtadic
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-05T16:35Z
sparring_record: .kiro/specs/live-room-edit-cohost/sparring/verdict.md
vtids: [VTID-05558, VTID-05559, VTID-05560, VTID-05561]
---
# Handoff — live-room-edit-cohost

Plan: `plan.md`. Tasks: `tasks.md`. Four lanes, serial by design (`depends_on` chain), two per repo:
- `db-cohost-authz` (repo `exafyltd/vitana-platform`, executor kiro, seat exafy): host helper, co-host validation,
  host gates, `co_hosts` write guard.
- `gateway-cohost` (repo `exafyltd/vitana-platform`, executor kiro, seat exafy): enter and Daily token for co-hosts,
  create with co-hosts, edit endpoint.
- `v1-session-form` (repo `exafyltd/vitana-v1`, executor kiro, seat exafyltd): shared session form, co-host picker,
  Go Live uses both.
- `v1-edit-session` (repo `exafyltd/vitana-v1`, executor kiro, seat exafyltd): Edit Session on the shared form, co-host
  aware cards and viewer.

Owner stop to expect: applying `20261105170000_live_room_cohost_authz.sql` needs the owner's approval of the file and
the target database (`collaboration.md` §7d). Everything else runs without questions.

## Log
### 2026-11-05T16:40Z · kiro-jtadic-202611051617-04a8 · drafted
Written on the owner's request of 5 Nov 2026 (Edit Session must match Go Live; co-host picker; co-hosts can run the
live). Investigation: EditSessionDialog.tsx, GoLivePopup.tsx, live.ts, room-session-manager.ts and the live-room SQL
functions were read on origin/main; findings are in plan.md "Today".

### 2026-11-05T16:35Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 4 lane(s) got a VTID and are handed to Kiro.

### 2026-11-05T16:55Z · kiro-jtadic-202611051617-04a8 · approved (driver: merging the plan PR)
Sparring converged in round 2 (verdict.md); lanes have VTID-05558 (db-cohost-authz), VTID-05559 (gateway-cohost),
VTID-05561 (v1-session-form), VTID-05560 (v1-edit-session). The CI sparring commit left every PR workflow on
`action_required` (bot-authored head), so this driver commit gives the PR a head that runs its checks. Next: merge
PR #4708 under §7b once the checks are green, then build the lanes in `depends_on` order.
