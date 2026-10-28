# VTID-04837 — partner setup writes as shared services, retry-safe register and products

Slice 1 of the AI-first Commerce setup (owner decisions 2026-10-02: AI setup is
the primary path, Vitana talks to the supplier, the supplier confirms a review
card with one tap; the owner runs the end-to-end write on staging).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Registering a business without a key behaves exactly as before: one org (`status: pending_review`), one org_admin membership, one `partner_org.registered` event, the route's 400/409/500 bodies unchanged.
  TEST: services/gateway/test/vtid-04837-partner-setup-idempotency.test.ts
  TEST: services/gateway/test/partner-orgs.test.ts
AC-2: A register retried with the same key (Idempotency-Key header / setupKey) returns the same org with 200, writes no second org and emits no second event; a concurrent duplicate resolves to the winner; another owner can never replay someone else's key.
  TEST: services/gateway/test/vtid-04837-partner-setup-idempotency.test.ts
AC-3: A replay repairs a missing org_admin membership (the old two-write orphan-org gap).
  TEST: services/gateway/test/vtid-04837-partner-setup-idempotency.test.ts
AC-4: Merchant upsert and product create keep their behaviour (hidden drafts, NO_MERCHANT, CATALOGUE_LOCKED, invalid_product, catalogue step + event only on a real transition).
  TEST: services/gateway/test/partner-onboarding-catalogue.test.ts
  TEST: services/gateway/test/vtid-04837-partner-setup-idempotency.test.ts
AC-5: A product created with a key is idempotent: the key is part of `source_product_id` (UNIQUE per source network), and a retry returns the existing product instead of a duplicate.
  TEST: services/gateway/test/vtid-04837-partner-setup-idempotency.test.ts
AC-6: Both routes stay mounted behind their auth gate on staging (no write is ever sent there).
  TEST: docs/validation/VTID-04837/staging-tests.json

## Scope

- `services/gateway/src/services/partner-setup.ts` (new): the register, merchant and product writes, moved verbatim from the route handlers, plus the optional keys.
- `services/gateway/src/routes/partner-orgs.ts`, `services/gateway/src/routes/partner-onboarding-catalogue.ts`: call the service.
- No new route, no schema change, no migration. OASIS: existing events only (`partner_org.registered`, `partner_org.catalogue_step_changed`).
