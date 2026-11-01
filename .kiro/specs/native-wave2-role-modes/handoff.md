---
slug: native-wave2-role-modes
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-28T13:40Z
sparring_record: .kiro/specs/native-wave2-role-modes/sparring/verdict.md
spar_refs:
  - exafyltd/vitana-v1: main
vtids: [VTID-05398, VTID-05399, VTID-05400, VTID-05401]
---
# Handoff — Native Wave 2: Role-mode screen ports (patient / professional / staff / business)
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the role-mode web screens the parity ledger assigns to
`"lane": "role-modes"` to native at 1:1 **mobile-web** parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). Plan block:
`plan.md`. Lanes: `lanes/*.md` (4, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail, disjoint
`paths`, no `vtid` yet). No web screen, `App.tsx` route or registry/manifest change — only native route files and
parity-row status flips.

Note on `spar_refs`: the frontend repo `exafyltd/vitana-v1` is listed at ref `main` so the repaired PLAN-SPAR
(live on main, commit `55cc5bbadc`) forwards `extra_refs: { 'exafyltd/vitana-v1': <sha> }` and the sparring
partner can read the `apps/mobile/**`, `packages/core/**`, `src/pages/<role>/**` and `apps/mobile/parity/ledger.json`
premises this plan cites.

## Log
### 2026-10-28T00:00Z · kiro-planner · re-created → drafted
Re-authored after the earlier reviewer-approved spec files were lost: a `git worktree add` timed out on Windows and
left broken reparse-point stubs for the six spec files; they were pruned, and the `kiro/native-wave2-role-modes/plan`
branch carried no spec commits. Re-created cleanly from the known-correct decomposition, mirroring the sibling spec
`native-wave2-home-feed-news` structure exactly.

Re-verified against `exafyltd/vitana-v1` `origin/main` `apps/mobile/parity/ledger.json` (version 2, 435 rows):
**35 rows carry `"lane": "role-modes"`, every one `status: "not_started"`** (34 `source: role-route`, 1
`source: exclusion` — `/commerce/connect/authorize`). Partitioned into **4 disjoint lanes by role prefix**:
`patient` 8 + `professional` 8 + `staff` 8 + `business` 11 = **35**, counted with `node -e` over the committed
ledger — **0 overlap, 0 orphan** (verified). The business lane owns the 1 exclusion row. Native subtrees are
disjoint (`app/(app)/<role>/**` + `src/screens/<role>/**` per lane). ADMIN (93 `/admin/*` rows, all
`scope: out:system-browser`) is **excluded** — opened in an in-app system browser, no native port (program §2
decisions 3/7); stated in `requirements.md` "Out of scope" and `design.md`.

Class split re-verified by imports on origin/main: **class-A core-extractable** = `src/lib/business-mode.ts`,
`src/config/drawer-nav.config.ts`, `src/lib/role-switch-destination.ts` (business-mode and drawer-nav are ALREADY
in `packages/core/src/extracted/*.generated.ts`; `permissions.ts` is ALREADY re-exported in
`packages/core/manifest.json`). **class-B re-implemented natively** = `usePatientAccess`, `useActivateReseller`,
`useResellerSales` and the other data hooks (all import `@/integrations/supabase/client`). Core extraction is
class-A only. No VTID allocated, no product code changed, no live system touched.

Next: PLAN-SPAR spars the `plan(native-wave2-role-modes)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims lanes
(all four independent — no `depends_on` — so all run in parallel). Reviewer seat `hotmail` reviews each lane.
Device-runtime parity (the last task in each lane) waits on the owner's G1 isolated test environment.

### 2026-10-28T13:40Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 4 lane(s) got a VTID and are handed to Kiro.
