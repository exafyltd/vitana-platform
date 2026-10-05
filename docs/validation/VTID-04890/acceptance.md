# VTID-04890 — Commerce MCP sets a missing business type

## Acceptance

- **AC-1** `update_business` accepts `business_type` (the five partner types) and sets it only when the business is a `draft` whose type is null. A type already set is refused with `PARTNER_TYPE_ALREADY_SET` (same type again is a no-op); any other lifecycle state is refused with `PARTNER_TYPE_LOCKED`. The write is conditional on `partner_type IS NULL AND lifecycle_state = 'draft'`, so a concurrent change is never overwritten.
- **AC-2** The status of a business without a type reports `next_step: "business_type"`, `missing_to_submit: ["business_type"]`, the allowed `business_types` and a hint telling the assistant to ask the supplier and not to call `create_business`. Typed businesses read exactly as before.
- **AC-3** `update_business` validates the facts and runs the verification-confirmation check before writing anything, sets the type before the facts, and never creates a business.

## Out of scope

No migration, no data change (the existing typeless draft is repaired by its owner through the assistant after deploy), no new route, no frontend, no flag change. The REST `PATCH …/company` route is unchanged.

## Proof

- Jest: `services/gateway/test/vtid-04890-commerce-business-type.test.ts` (+ `commerce-mcp.test.ts` unchanged).
- Staging (read-only): unsigned `POST /mcp` → 401; the Jest suite at the deployed commit.
- Owner on staging, through Claude: set the business type on the typeless draft; the status then lists real steps.
