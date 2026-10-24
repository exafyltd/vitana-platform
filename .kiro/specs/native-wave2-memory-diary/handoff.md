---
slug: native-wave2-memory-diary
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-21T19:13Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Memory / Diary screen ports
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the 7 web destinations the parity ledger assigns to
`"lane": "memory-diary"` (vitana-v1 origin/main, ledger version 2, 435 rows) to native at 1:1 mobile-web parity on
`@vitana/core` + `@vitana/ui` + the N3 shell; fixture / fake-gateway tests only, device-runtime parity deferred to G1
(`next_actor: owner`). Plan block: `plan.md`. Lanes: `lanes/*.md` (2 — `memory`, `diary` — all `ready`, executor
kiro, seat exafyltd → reviewer_seat hotmail, disjoint `paths`, no `vtid` yet). No web screen, `App.tsx` route or
registry/manifest change — only native route files, a DE-first i18n key (+ its mirrors), at most a `@vitana/core`
re-export line, and parity-row status flips. Ledger investigation: `sparring/ledger-findings.md` (read-only,
verified against vitana-v1 origin/main).
## Log
### 2026-10-21T19:13Z · kiro-planner · created → drafted
Holder of the `native-wave2-memory-diary/_plan` claim (planner). Measured against vitana-v1 origin/main
(`git show origin/main:apps/mobile/parity/ledger.json`): ledger **version 2, 435 rows**, **7 rows with
`"lane": "memory-diary"`, every one `not_started`** (all `kind: screen`, `scope: in`, `source: registry`,
`exception: null`, `owner: null`). Verified the cluster's web source pages exist (`src/pages/Memory.tsx`,
`memory/Timeline.tsx`, `memory/Recall.tsx`, `memory/Permissions.tsx`, `MobileDailyDiary.tsx`) and the App.tsx route
lines per `sparring/ledger-findings.md`. Class determination (ledger-findings §3): **every runtime data path in the
cluster is class-B** (imports `@/lib/community-gateway` transitively via `memory-api`/`memory-learning-api`/
`timeline-api`, or `@/integrations/supabase/client`), so the cluster is re-implemented natively against the
`@vitana/core` gateway helper + native supabase client — no clean full-module class-A re-export was found. Wrote
requirements, design, tasks, plan and 2 lane files; partitioned the 7 rows into `memory` (4) and `diary` (3) with
disjoint native file subtrees and ledger rows-by-row — 0 overlap, 0 orphan. No VTID allocated, no product code
changed, no live system touched.
Next: PLAN-SPAR spars the `plan(native-wave2-memory-diary)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims
`memory` and `diary` in parallel (no deps between them). Reviewer agent `vitana-lane-reviewer` accepts each lane.
Device-runtime parity (task 8 in each lane) waits on the owner's G1 isolated test environment.
