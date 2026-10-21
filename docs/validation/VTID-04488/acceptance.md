# VTID-04488 — Commerce partner onboarding Phase 1: the catalogue step

Spec §6.1/§6.2 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md`: "`/:orgId/catalogue/*` — product, panel or service CRUD … wraps the existing `/vcaop/portal/my/products` logic".

## What changed

- **New router** `routes/partner-onboarding-catalogue.ts`, mounted on `/api/v1/partner-onboarding`, org_admin only. It has four endpoints:
  - `GET /:orgId/catalogue` returns the org's merchant and products.
  - `PUT /:orgId/catalogue/merchant` creates or updates the org's merchant. It pre-fills the name, country and website from the org. Labs default to the `diagnostics` vertical, and practitioners and service providers to `services`; shops and brands must choose one.
  - `POST /:orgId/catalogue/products` adds a product.
  - `PATCH /:orgId/catalogue/products/:productId` changes one of the org's products.
- **The supplier portal's rules are reused, not copied.** `MerchantSchema`, `ProductSchema`, `ProductPatchSchema`, the ships-to rule and the `supplier_referral` source network are imported from `vcaop-portal-my-products.ts`. They are now exported there, and the portal's behaviour is unchanged.
- **The merchant belongs to the org** (`merchants.partner_organization_id`, VTID-04471), not to one user.
  - A merchant the owner made through the old portal and never linked to an org is adopted rather than duplicated.
  - A merchant created here carries no `owner_user_id`. The old portal looks up a merchant with `.maybeSingle()` on `owner_user_id`, and a second row per owner would break that lookup.
- **Nothing goes live on the partner's say-so.** The merchant is `draft` and `is_active: false`, and so is every product.
- **The catalogue step** is `in_progress` once the org has a merchant and `done` once it has a product. The row is written after every change. `partner_org.catalogue_step_changed` is emitted only when the status moves.
- **Locked** (409 `CATALOGUE_LOCKED`) for rejected and suspended orgs.

## Acceptance criteria

AC-1 Access. Without a token the response is 401 JSON. A non-admin gets 403 with no merchant query. A rejected org gets 409 `CATALOGUE_LOCKED` before any write.
TEST: services/gateway/test/partner-onboarding-catalogue.test.ts

AC-2 Merchant.
- A shop without a vertical gets 400.
- The merchant is created from the company facts with `partner_organization_id`, `supplier_referral:org:<orgId>`, `draft` and `is_active: false`, and without `owner_user_id`.
- A lab defaults to `diagnostics`.
- The owner's unlinked portal merchant is adopted, with the update guarded on `partner_organization_id IS NULL` and no insert.
- An update of the existing merchant that does not move the step emits no event.
TEST: services/gateway/test/partner-onboarding-catalogue.test.ts

AC-3 Products.
- Before a merchant exists the response is 409 `NO_MERCHANT`.
- A product that ships nowhere gets 400.
- A new product is a draft under the org merchant, even when `is_active: true` is sent. It completes the step, and the checklist shows `done`.
- PATCH is scoped by `merchant_id`, so another org's product returns 404.
- The ships-to rule is judged against the merged product.
TEST: services/gateway/test/partner-onboarding-catalogue.test.ts

AC-4 The step and event. The step row is `in_progress` or `done` with `{merchant_id, product_count}`. `partner_org.catalogue_step_changed` carries `from`, `to` and `product_count`, and is emitted only on a status change.
TEST: services/gateway/test/partner-onboarding-catalogue.test.ts

## Route mount

ROUTE_MOUNT: new `mountRouterSync(app, '/api/v1/partner-onboarding', partnerOnboardingCatalogueRouter, { owner: 'partner-onboarding-catalogue' })` in `src/index.ts`, directly after the engine router. The paths do not collide; this is the same pattern as the two VCAOP `/portal/my` routers.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/<orgId>/catalogue` (staging, after merge).
CURL_PROOF: **not yet run.** The router is deployed nowhere. `test/partner-onboarding-catalogue.test.ts` exercises it with supertest. After the staging deploy, `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/catalogue` should return `401 application/json`.
CURL: see CURL_PROOF above.

## OASIS

OASIS_IMPACT: yes. New topic `partner_org.catalogue_step_changed`, with payload `partner_organization_id`, `from`, `to` and `product_count`. It is emitted on step transitions only. Individual draft saves stay silent, following the supplier portal's own rule (CLAUDE.md §6).

OASIS_PROOF: the route suite asserts the event on the transitions and its absence on saves that do not move the step. After deploy, check with:
`SELECT topic, metadata->>'to', metadata->>'product_count' FROM oasis_events WHERE topic = 'partner_org.catalogue_step_changed' ORDER BY created_at DESC LIMIT 5;`

## Not in this VTID

- CSV upload and feed URLs, including network feeds for affiliate brands, get their own VTID.
- The §7 catalogue content scan (prohibited categories, health claims, broken links) is not built.
- Approval of the merchant and products still goes through the existing admin marketplace surface.
- No schema change.
