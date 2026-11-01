---
slug: native-wave2-profile-settings-r2
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-01T03:04Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/native-wave2-profile-settings-r2/sparring/verdict.md
vtids: [VTID-05428, VTID-05429, VTID-05430, VTID-05431, VTID-05432]
---
# Handoff — Native Wave 2: Profile / Settings / Support / Connectors screen ports
Wave 2 screen-port batch of the Maxina native app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the 37 web destinations the parity ledger assigns to
`"lane": "profile-settings-support"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3
shell; fixture / fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). No web screen,
`App.tsx` route or registry/manifest change — and no `@vitana/core` extraction (the cluster's hooks are class-B data
hooks, re-implemented natively) — only native route files and parity-row status flips.
Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail,
disjoint `paths`, no `vtid` yet).
Re-plan of `native-wave2-profile-settings` (PR #4278, converged) under a new slug; the old branch has commits without Collab trailers. Sparring history: https://github.com/exafyltd/vitana-platform/pull/4278.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-7819 · created → drafted
Holder of the `native-wave2-profile-settings-r2/_plan` claim. Re-plan of `native-wave2-profile-settings` (PR #4278, converged and policy-approved), whose branch cannot pass Collab handoff without a history rewrite (commits without a Collab-Session trailer). Copied the converged plan, tasks, requirements, design and lane files from the old PR head; lane VTIDs removed (CI allocates on convergence), lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-profile-settings-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-01T01:17Z · kiro-exafyltd-202611010001-7819 · drafted (sparring round 1 answered)
R1-F1 accepted: `/delete-account` stays public natively, as `apps/mobile/app/(public)/delete-account.tsx` in a new lane `delete-account` (the `settings` lane file cannot be edited by a `_plan` commit). Now 4 lanes: 5 + 17 + 1 + 14 = 37 rows. Answers: `sparring/responses-1.md`.
### 2026-11-01T02:14Z · kiro-exafyltd-202611010001-7819 · drafted (sparring round 2 answered)
R2-F1 accepted: `/u/:identifier` and `/profile/:id` stay public natively, in a new lane `public-profile` in `(public)` (shell chosen by session). Now 5 lanes: 2 + 3 + 17 + 1 + 14 = 37 rows. Answers: `sparring/responses-2.md`.

### 2026-11-01T03:04Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 5 lane(s) got a VTID and are handed to Kiro.
