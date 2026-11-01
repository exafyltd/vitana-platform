---
slug: native-wave2-public-auth-onboarding-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T01:17Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Public / Auth / Onboarding / Legal screen ports
Wave 2 public/auth/onboarding/legal screen-port batch of the native Maxina app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021; Wave 2 lane list in §5). Sibling of the first
Wave 2 batch `native-wave2-home-feed-news`; reuses the link + auth plumbing the `native-g1-wiring` lane (VTID-05178)
and N3 (VTID-05186) already built. Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat
exafyltd → reviewer_seat hotmail, disjoint `paths`, no `vtid` yet). Ports the 20 web destinations the parity ledger
assigns to `"lane": "public-auth"` to native at 1:1 mobile-web parity (the `PublicAppShell` branch) on
`@vitana/core` + `@vitana/tokens` + `@vitana/ui` + the N3 shell; sign-in is the one allowed auth write, everything
else read/fixture only; fixture / fake-gateway tests only, device-runtime and the real OAuth browser round-trip
deferred to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native route
files and parity-row status flips.
Re-plan of `native-wave2-public-auth-onboarding` (PR #4275, converged) under a new slug; the old branch has commits without Collab trailers. Sparring history: https://github.com/exafyltd/vitana-platform/pull/4275.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-cfe9 · created → drafted
Holder of the `native-wave2-public-auth-onboarding-r2/_plan` claim. Re-plan of `native-wave2-public-auth-onboarding` (PR #4275, converged and policy-approved), whose branch cannot pass Collab handoff without a history rewrite (commits without a Collab-Session trailer). Copied the converged plan, tasks, requirements, design and lane files from the old PR head; lane VTIDs removed (CI allocates on convergence), lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-public-auth-onboarding-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-01T01:17Z · kiro-exafyltd-202611010001-cfe9 · drafted (re-plan session)
Session 1 (`023c2655-8525-4b01-a249-bab1d8050566`) escalated with zero findings (`evidence_floor_not_met`, a partner-side failure). Added one line to the plan block so PLAN-SPAR opens the re-plan session; no plan content changed.
