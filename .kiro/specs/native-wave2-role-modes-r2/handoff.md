---
slug: native-wave2-role-modes-r2
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-02T21:38Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/native-wave2-role-modes-r2/sparring/verdict.md
vtids: [VTID-05524, VTID-05525, VTID-05526, VTID-05527]
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
Re-plan of `native-wave2-role-modes` (PR #4434) under a new slug; the old branch has a commit without a Collab-Session trailer (Collab handoff on main cannot accept it without a history rewrite) and the spec is not listed in docs/programs/native-app/program.md; it is the converged, policy-approved plan of `native-wave2-role-modes` (PR #4434), whose VTIDs are retired with that PR. Sparring history: https://github.com/exafyltd/vitana-platform/pull/4434.
## Log
### 2026-11-02T11:03Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-role-modes-r2/_plan` claim. Re-plan of `native-wave2-role-modes` (PR #4434), because the old branch has a commit without a Collab-Session trailer (Collab handoff on main cannot accept it without a history rewrite) and the spec is not listed in docs/programs/native-app/program.md; it is the converged, policy-approved plan of `native-wave2-role-modes` (PR #4434), whose VTIDs are retired with that PR. Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-role-modes-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-02T20:56Z · kiro-exafyltd-202611011658-9f52 · drafted (sparring round 1 answered)
R1-F1 accepted: the spec is registered in `docs/programs/native-app/program.md` by this PR; the plan block now says so. Answers: `sparring/responses-1.md`.

### 2026-11-02T21:38Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 4 lane(s) got a VTID and are handed to Kiro.
