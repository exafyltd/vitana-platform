---
lane: supplier-onboarding-communities
state: ready
next_actor: owner
depends_on: [supplier-relationships-db]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/partner-onboarding-service.ts
  - services/gateway/src/routes/partner-onboarding.ts
  - services/gateway/src/routes/partner-onboarding-catalogue.ts
  - services/gateway/src/services/recommendation-commissions/credit-recommender.ts
  - services/gateway/src/services/recommendation-commissions/credit-recommender-repository.ts
  - services/gateway/src/routes/click-redirect.ts
  - services/gateway/test/vtid-*-supplier-onboarding-communities.test.ts
  - services/gateway/test/vtid-*-referral-tenant-attribution.test.ts
updated: 2026-10-15T16:40Z
---
# supplier-onboarding-communities — "which communities" + platform/commerce path + attribution (VTID allocated by PLAN-SPAR, repo vitana-platform)

Plan: `.kiro/specs/mt-discover/plan.md` (authoritative) and the `supplier-onboarding-communities` group in `tasks.md`
(tasks S1–S6, allowed paths, acceptance). Design + successor rules: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID — PLAN-SPAR flips it to `kiro`. Depends on
`supplier-relationships-db` (writes `proposed` rows into `supplier_tenant_relationships`, reads the referral tenant
column): do not start before it is done.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, and NEVER run a provisioning/onboarding write
endpoint against any live system. Work only inside the allowed paths. `signup_intent` is untrusted client metadata —
it may route a signup to the platform-tenant path (O5/§4.10) but grants nothing. Dark by default behind the mt flags.
This lane adds its own `docs/validation/<vtid>/`. Branch `kiro/mt-discover/supplier-onboarding-communities`; PR title
`VTID-xxxxx (mt-discover/supplier-onboarding-communities): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-discover/supplier-onboarding-communities`. When the PR
is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release
the claim. Supplier screens follow the Commerce UX contract — but the UI itself lives in the `discover-mode-ui` lane
(vitana-v1); this lane is the gateway service + routes.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created, HELD at `next_actor: owner`. Gateway code lane (seat `jtadic`). "Which communities" step →
`proposed` relationships; tenant accept/decline; platform tenant + `signup_intent='commerce'` path (drops hardcoded
Maxina); referral attribution carries the buyer's tenant and recommender earnings follow the recommender's tenant
(D26). Depends on `supplier-relationships-db`.
