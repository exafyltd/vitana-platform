---
slug: native-wave2-events-calendar
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-21T20:30Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Events / Meetups / Calendar / Reminders / Live-rooms screen ports
Second Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Follows the first Wave 2 batch `native-wave2-home-feed-news` (home / feed
/ news). Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat
hotmail, disjoint `paths`, no `vtid` yet). Ports the 22 web destinations the parity ledger assigns to
`"lane": "events-calendar"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity (the live-rooms Daily.co join especially) deferred to G1
(`next_actor: owner`). No web screen, `App.tsx` route or registry / manifest change — only native route files and
parity-row status flips.
## Log
### 2026-10-21T20:30Z · kiro-planner · created → drafted
Holder of the `native-wave2-events-calendar/_plan` claim (planner). Measured on the worktree (= origin/main):
`apps/mobile/parity/ledger.json` version 2 has **22 rows with `"lane": "events-calendar"`, every one `not_started`**
(14 screen, 3 overlay — incl. the `/calendar` overlay — and 6 exclusion routes; 435 rows total), counted with `node -e`
over the committed ledger (the `--report` CLI needs `typescript`, not installed here). Verified the web source pages
(`EventsAndMeetups.tsx` 1489, `LiveRooms.tsx` 1073, `LiveRoomViewer.tsx` 421, `Calendar.tsx` 552, `Reminders.tsx` 66),
the three Create/Edit dialogs, the live-room + reminder + calendar `vcal/**` subtrees, and the `App.tsx` route lines
all exist. Confirmed the class-B set (pages/dialogs that runtime-import `@/integrations/supabase/client.ts`) that must
NOT move into `@vitana/core`, and the candidate pure helper modules per lane. Wrote requirements, design, tasks, plan
and 3 lane files; partitioned the 22 rows into `events-meetups` (12), `calendar-reminders` (4), `live-rooms` (6) with
disjoint native file subtrees and ledger rows-by-row — 0 overlap, 0 orphan. No VTID allocated, no product code
changed, no live system touched.
Next: PLAN-SPAR spars the `plan(native-wave2-events-calendar)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims the three
lanes in parallel (no cross-lane deps). Reviewer seat `hotmail` reviews each lane. Device-runtime parity (the last task
in each lane) waits on the owner's G1 isolated test environment; the live-rooms Daily.co video join can only be
exercised there.
