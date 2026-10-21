---
slug: native-wave2-inbox-chat-calls
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-15T19:13Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Inbox / Chat / Calls screen ports
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021; Wave 2 lane list in §5). Ports the 9 web destinations the parity ledger assigns to
`"lane": "inbox-chat-calls"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity (and especially the realtime + WebRTC call journey) deferred
to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native route files and
parity-row status flips. Plan block: `plan.md`. Lanes: `lanes/*.md` (2, both `ready`, executor kiro, seat exafyltd →
reviewer_seat hotmail, disjoint `paths`, no `vtid` yet).

## Log
### 2026-10-15T19:13Z · kiro-planner · created → drafted
Session `kiro-202610151913-51bd`, lane `native-wave2-inbox-chat-calls/_plan` (planner). Measured on the worktree
(= origin/main): `apps/mobile/parity/ledger.json` has **9 rows with `"lane": "inbox-chat-calls"`, every one
`not_started`** (5 `screen`/`registry`, 4 `route`/`exclusion`), counted with `node -e` over the committed ledger
(NOT prose — the home batch had a double-count bug). Verified there is **no separate call/room row** in this lane
(Live Rooms rows are `events-calendar`; 1:1 WebRTC calling is embedded in the conversation surface,
`src/pages/Messages.tsx:1227-1569`, so it ports with the chat lane and flips no extra row). Verified all web source
pages/components exist with the cited line counts and the `src/App.tsx:1352-1410` routes, and confirmed every
chat/call data hook is class B (runtime-imports `@/integrations/supabase/client.ts`) so none can enter `@vitana/core`.
Wrote requirements, design, tasks, plan and 2 lane files; partitioned the 9 rows into `inbox-list` (3) and
`conversation-chat` (6) with disjoint native file subtrees and ledger-rows-by-row — 0 overlap, 0 orphan. No VTID
allocated, no product code changed, no live system touched.

Next: PLAN-SPAR spars the `plan(native-wave2-inbox-chat-calls)` PR (reading both repos via `extra_refs`); this
session answers each round in `sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then
seat `exafyltd` claims lanes — `inbox-list` and `conversation-chat` in parallel (no `depends_on` between them).
Reviewer seat `hotmail` reviews each lane. Device-runtime parity and the live realtime/call journey (task 7 in each
lane) wait on the owner's G1 isolated test environment.
