# VTID-04890 — Commerce MCP sets a missing business type

A business registered through `/partner-orgs/register` may have no `partner_type`:
it then has no checklist, can never be submitted (`PARTNER_TYPE_MISSING`), and nothing
could give it a type. Through the Commerce MCP its status read "not ready" with no
steps and no next step. Owner rule (2026-10-05): `update_business` may set
`business_type` only on a draft whose type is null, never change it once set, and
the status of a typeless business names the missing step.

VALIDATION_PROFILE: gateway_backend

CURL_PROOF: no route added or changed. After the staging deploy STAGING-VERIFY runs docs/validation/VTID-04890/staging-tests.json — an unsigned `POST https://preview-aws-gateway.vitanaland.com/mcp` answers 401 (rejected probe; nothing is written), plus the Jest suite below at the deployed commit.

OASIS_PROOF: `setMissingPartnerType` emits `partner_org.partner_type_set` (payload: partner_organization_id, partner_type; source commerce-mcp) only when the type was actually written; asserted in services/gateway/test/vtid-04890-commerce-business-type.test.ts (emitted on a real write, not emitted on a no-op or a refused/concurrent write).

## Acceptance criteria

AC-1: `update_business` sets `business_type` only on a `draft` whose type is null (conditional write on `partner_type IS NULL AND lifecycle_state = 'draft'`); a different existing type → `PARTNER_TYPE_ALREADY_SET`, the same type → no-op, any other lifecycle state → `PARTNER_TYPE_LOCKED`; a concurrent write is never overwritten.
  TEST: services/gateway/test/vtid-04890-commerce-business-type.test.ts
AC-2: The status of a business without a type reports `next_step: "business_type"`, `missing_to_submit: ["business_type"]`, the allowed `business_types` and an assistant hint (ask the supplier; do not call create_business). Typed businesses read exactly as before.
  TEST: services/gateway/test/vtid-04890-commerce-business-type.test.ts
AC-3: `update_business` exposes `business_type` in its schema, validates facts and runs the verification-confirmation check before any write, sets the type before the facts, and never creates a business.
  TEST: services/gateway/test/vtid-04890-commerce-business-type.test.ts
  TEST: services/gateway/test/commerce-mcp.test.ts

## Out of scope

No migration, no data change (the existing typeless draft is repaired by its owner through the assistant after deploy), no new route, no frontend, no flag change. The REST `PATCH …/company` route is unchanged.

## Owner check on staging

Through Claude: set the business type on the typeless draft; the status then lists real steps.
