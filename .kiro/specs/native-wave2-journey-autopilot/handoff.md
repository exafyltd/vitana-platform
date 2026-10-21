---
slug: native-wave2-journey-autopilot
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-15T19:13Z
sparring_record: .kiro/specs/native-wave2-journey-autopilot/sparring/verdict.md
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Journey / Guided mode / Autopilot screen ports
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the 2 web destinations the parity ledger assigns to
`"lane": "journey-autopilot"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). No web screen,
`App.tsx` route or registry/manifest change — only native route files and parity-row status flips.
Plan block: `plan.md`. Lanes: `lanes/*.md` (2, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail,
disjoint `paths`, no `vtid` yet).
## Log
### 2026-10-15T19:13Z · kiro-planner · created → drafted
Holder of the `native-wave2-journey-autopilot/_plan` claim (planner). Measured on the worktree (= origin/main):
`apps/mobile/parity/ledger.json` version 2 has **2 rows with `"lane": "journey-autopilot"`, both `not_started`**
(1 `screen` from `registry` — `AUTOPILOT.MY_JOURNEY /autopilot`; 1 `route` from `exclusion` — `/autopilot/audiobook`;
435 rows total), counted with `node -e` over the committed ledger (the `--report` CLI needs `typescript`, not
installed here). Cross-checked against `scripts/native/parity-scope.json` (lane label "Journey / Guided / Autopilot"
`:6`, `/autopilot`→`journey-autopilot` prefix `:109`, `/autopilot/audiobook` `scope: in` `:77`) and
`src/navigation/registry/exclusions.json:211`. Verified the web sources: both routes render
`src/pages/AutopilotDashboard.tsx` (605; `src/App.tsx:1538-1548`); the journey components, the autopilot popup (717),
the guided-mode provider (221) and the audiobook player provider (528) + mini-player (259) exist. Verified the
class split for extraction: `src/lib/horizonBuckets.ts` and `src/lib/vitana-projection.ts` are IO-free (class A,
extractable); every hook/provider in the cluster runtime-imports `@/lib/community-gateway` or
`@/integrations/supabase/client` (class B, re-implemented natively, never extracted). Wrote requirements, design,
tasks, plan and 2 lane files; partitioned the 2 rows into `journey` (1) and `autopilot-audiobook` (1) with disjoint
native file subtrees and ledger-rows-by-row — 0 overlap, 0 orphan. No VTID allocated, no product code changed, no
live system touched.
Next: PLAN-SPAR spars the `plan(native-wave2-journey-autopilot)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI policy-approves (`converged-auto-v1`) and writes the VTIDs into the
lanes; then seat `exafyltd` claims lanes in dependency order — `journey` first, `autopilot-audiobook` after `journey`
is `done` (it renders the dashboard screen that `journey` owns, via a port, and consumes the core helpers that
`journey` adds). Reviewer seat `hotmail` reviews each lane. Device-runtime parity (the last task in each lane) waits
on the owner's G1 isolated test environment.
