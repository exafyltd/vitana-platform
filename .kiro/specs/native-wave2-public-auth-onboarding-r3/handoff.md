---
slug: native-wave2-public-auth-onboarding-r3
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T17:25Z
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
Re-plan of `native-wave2-public-auth-onboarding-r2` (PR #4545) under a new slug; both sparring sessions of `native-wave2-public-auth-onboarding-r2` escalated on the partner's evidence floor (`evidence_floor_not_met`, 0 premise checks, 0 findings — a partner-side failure, not a plan finding) and the plan was parked; it is the converged plan of `native-wave2-public-auth-onboarding` (PR #4275). Sparring history: https://github.com/exafyltd/vitana-platform/pull/4545.
## Log
### 2026-11-01T17:25Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-public-auth-onboarding-r3/_plan` claim. Re-plan of `native-wave2-public-auth-onboarding-r2` (PR #4545), because both sparring sessions of `native-wave2-public-auth-onboarding-r2` escalated on the partner's evidence floor (`evidence_floor_not_met`, 0 premise checks, 0 findings — a partner-side failure, not a plan finding) and the plan was parked; it is the converged plan of `native-wave2-public-auth-onboarding` (PR #4275). Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-public-auth-onboarding-r3)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-01T17:59Z · kiro-exafyltd-202611011658-9f52 · drafted (sparring round 1 answered)
R1-F1 accepted: route line catalog corrected (`/` at App.tsx:818, `/_intro/:tenantSlug` at :819). Answers: `sparring/responses-1.md`.
