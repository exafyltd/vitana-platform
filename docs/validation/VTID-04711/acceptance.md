# VTID-04711 — OAuth callbacks record the surface that started the flow

Follow-up to the Codex P2 finding on PR #3691 (VTID-04527): an org admin who
started Shopify or SMART-on-FHIR authorization from the org-scoped
partner-onboarding routes got `surface: merchant_self_service` on the callback's
OASIS events, because both callbacks hardcoded it.

## Change

- `services/vcaop-portal/connection-surface.ts` — the surface allowlist
  (`merchant_self_service`, `partner_onboarding`); anything else, or nothing,
  resolves to `merchant_self_service`.
- Shopify state: the surface is inside the HMAC-signed payload
  (`manifest.expires.surface.sig`). The merchant surface keeps the pre-04711
  three-part token, so tokens minted before the deploy still verify.
- FHIR state: optional `surface` field inside the AES-256-GCM payload.
- `registerConnectionRoutes` passes `scope.surface` into both states; both
  callbacks record the decoded surface on `*_authorized` and
  `*_credential_persist_failed`.

## Acceptance criteria

- AC-1: a Shopify state signed for `partner_onboarding` decodes to that surface; the merchant surface keeps a three-part token.
  TEST: services/gateway/test/services/shopify-oauth.test.ts
- AC-2: swapping the surface inside a signed Shopify state is rejected; an unknown surface in a validly signed state falls back to the merchant surface.
  TEST: services/gateway/test/services/shopify-oauth.test.ts
- AC-3: the encrypted FHIR state carries the surface; a state without one decodes with none.
  TEST: services/gateway/test/services/smart-fhir-oauth.test.ts
- AC-4: both callbacks record the surface from state, and the merchant surface when state has none.
  TEST: services/gateway/test/routes/shopify-oauth-callback.test.ts
  TEST: services/gateway/test/routes/fhir-oauth-callback.test.ts
- AC-5: a Shopify authorize started from the org-scoped route mints a `partner_onboarding` state.
  TEST: services/gateway/test/partner-onboarding-connections.test.ts
- AC-6: the merchant surface is unchanged.
  TEST: services/gateway/test/routes/vcaop-portal-my.test.ts

## Staging

Staging has no Shopify/FHIR OAuth app configured — both callbacks answer
`503 not_configured` (see `outputs/staging-probe.txt`), so no real OAuth
round trip can run there. The staging suite probes the routes read-only and
runs the unit/integration suites above.

OASIS_PROOF: no new event types; `surface` on `vcaop.portal.connection.shopify_authorized`,
`…shopify_credential_persist_failed`, `…fhir_authorized`, `…fhir_credential_persist_failed`
now reflects the initiating surface.
