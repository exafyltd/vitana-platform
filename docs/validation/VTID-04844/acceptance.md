# VTID-04844 — Vitana as the Commerce supplier onboarding guide

Owner request 2026-10-02: when the supplier taps "Talk to Vitana", Vitana is a
specialist for supplier onboarding and every Vitanaland Commerce question —
"exactly how a smart assistant, a true guide, should work".

VALIDATION_PROFILE: gateway_backend

OASIS_IMPACT: no — instruction text and a read-only session-start lookup.

## Acceptance criteria

AC-1: The commerce work-surface instruction carries guide conduct (start from where the supplier is, one step at a time, say why, offer the screen, check before stating, the screen commits) and grounded Commerce facts (types, setup steps, hidden drafts until review, going live by rules, CSV import, connections, team invites, health inbox); admin, BackOffice and Command Hub instructions are unchanged.
  TEST: services/gateway/test/vtid-04844-commerce-guide-instruction.test.ts
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
AC-2: Undecided commercial and legal terms (commission, payout/KYC, VAT, merchant of record, windows, visibility, health claims) are named as not settled, never promised; ranking never depends on commission.
  TEST: services/gateway/test/vtid-04844-commerce-guide-instruction.test.ts
AC-3: A commerce session starts with the caller's own businesses (memberships only), each with its setup state, open required steps, missing company fields and next step, from the same checklist code as the portal; it fails open to a generic opener.
  TEST: services/gateway/test/vtid-04844-commerce-guide-instruction.test.ts
AC-4: The commerce opener leads from where the supplier stands with one next step; the Talk-to-Vitana opener introduces the guide, then asks for the website (draft_business_setup), as English intent (NEVER rule 41).
  TEST: services/gateway/test/vtid-04844-commerce-guide-instruction.test.ts
  TEST: services/gateway/test/vtid-04840-commerce-setup-opening.test.ts
AC-5: The tenant-admin briefing is no longer loaded on the commerce surface (it leaked tenant admin insights into a supplier's context and opener).
  TEST: services/gateway/test/vtid-04844-commerce-guide-instruction.test.ts
AC-6: The commerce persona names the onboarding-guide role and lane; the surface still declares no member tools and no brain context.
  TEST: services/gateway/test/orb/live/commerce-surface.test.ts
  TEST: services/gateway/test/orb/live/instruction/work-surface-overlays.test.ts

## Scope

- New: `src/orb/live/instruction/commerce-guide.ts`, `src/orb/profile/commerce-knowledge.ts`, the Jest suite, this pack.
- Changed: `live-system-instruction.ts` (commerce branch), `work-surface-context.ts` (commerce loader), `live-session-controller.ts` (no admin briefing on commerce), `compute-greeting-decision.ts` (commerce intents), `ai-personality-service.ts` (commerce persona defaults), `routes/partner-onboarding.ts` (`loadChecklist` exported, unchanged).
- Facts sourced from partner-lifecycle.ts, partner-onboarding-checklist.ts, partner-onboarding-catalogue.ts, partner-orgs.ts, partner-onboarding-connections.ts and docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md (D-1..D-16).
