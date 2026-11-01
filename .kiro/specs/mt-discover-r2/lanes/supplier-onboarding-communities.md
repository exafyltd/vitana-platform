---
lane: supplier-onboarding-communities
state: ready
next_actor: kiro
depends_on: [supplier-relationships-db]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/partner-onboarding-service.ts
  - services/gateway/src/routes/partner-onboarding.ts
  - services/gateway/src/routes/partner-onboarding-catalogue.ts
  - services/gateway/src/services/recommendation-commissions/credit-recommender.ts
  - services/gateway/src/services/recommendation-commissions/credit-recommender-repository.ts
  - services/gateway/src/routes/click-redirect.ts
  - services/gateway/test/vtid-*-supplier-onboarding-communities.test.ts
  - services/gateway/test/vtid-*-referral-tenant-attribution.test.ts
updated: 2026-11-01T15:57Z
repos: [exafyltd/vitana-platform]
---
# supplier-onboarding-communities — "which communities" + platform/commerce path + attribution (VTID allocated by PLAN-SPAR, repo vitana-platform)

Plan: `.kiro/specs/mt-discover-r2/plan.md` (authoritative) and the `supplier-onboarding-communities` group in `tasks.md`
(tasks S1–S6, allowed paths, acceptance). Design + successor rules: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, and NEVER run a provisioning/onboarding write
endpoint against any live system. Work only inside the allowed paths. `signup_intent` is untrusted client metadata —
it may route a signup to the platform-tenant path (O5/§4.10) but grants nothing. Dark by default behind the mt flags.
This lane adds its own `docs/validation/<vtid>/`. Branch `kiro/mt-discover-r2/supplier-onboarding-communities`; PR title
`VTID-xxxxx (mt-discover-r2/supplier-onboarding-communities): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-discover-r2/supplier-onboarding-communities`. When the PR
is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release
the claim. Supplier screens follow the Commerce UX contract — but the UI itself lives in the `discover-mode-ui` lane
(vitana-v1); this lane is the gateway service + routes.

## Log
### 2026-11-01T15:57Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-discover/supplier-onboarding-communities`. Versions day-shifted to `20261102120*`. Reviewer agent.
