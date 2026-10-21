# VTID-04471 — Commerce partner onboarding Phase 1: partner account model

Phase 1 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` (VTID-04330),
§5.1 and §5.2. `partner_organizations` becomes the root that merchants and VCAOP
connections belong to, and gets an enforced partner type, a lifecycle and the
company facts the onboarding rules need.

## What changed

- **Supabase migration `20260924130000_vtid_04471_partner_account_model.sql`:**
  - New columns on `partner_organizations`: `partner_type`, `lifecycle_state`, `legal_name`, `country`, `vat_id`, `website` and `trust_level`.
  - Two mapping helpers and `trg_partner_organizations_sync`. The trigger keeps the legacy `status` column and `lifecycle_state` in sync in both directions, and derives `commerce_vertical` from `partner_type`.
  - New column `merchants.partner_organization_id` (FK) with an idempotent backfill.
- **Prisma migration `20260924_vcaop_partner_org_link_0007`:** adds `partner_tenant.partner_organization_id` (FK) with the same backfill, plus the matching field and index in `schema.prisma`.
- **`services/partner-lifecycle.ts`:** the pure rules module. It holds the partner types, the lifecycle states and allowed transitions, the lifecycle→status and type→vertical mappings, and validation of the company facts.
- **`POST /register`:**
  - accepts an optional `partner_type`; when present it decides `commerce_vertical`, and a conflicting value is a 400;
  - accepts optional company facts;
  - never accepts `lifecycle_state`, `trust_level` or `status` from the client.
- **`GET /mine`:** also returns `partner_type` and `lifecycle_state`.

## Acceptance criteria

AC-1 The allowed transitions follow spec §5.2:
- the happy path is `draft → submitted → verifying → live`;
- verification is never skipped;
- `needs_action` loops back through `verifying`;
- an exception review ends in `live`, `needs_action` or `rejected`;
- a `live` org can be paused and resumed, or suspended and reinstated;
- `rejected` is terminal.
TEST: services/gateway/test/vtid-04471-partner-account-model.test.ts

AC-2 The gateway's vocabularies and mappings match the migration. A test reads the SQL and checks the CHECK lists for `partner_type` and `lifecycle_state`, `partner_org_status_for_lifecycle()` and `partner_org_vertical_for_type()`.
TEST: services/gateway/test/vtid-04471-partner-account-model.test.ts

AC-3 Company facts are validated and normalised (country upper-cased, website must be http(s)). An invalid fact is a 400, never silently dropped.
TEST: services/gateway/test/vtid-04471-partner-account-model.test.ts

AC-4 `/register` with `partner_type` derives `commerce_vertical`, stores the facts and emits `partner_type` on `partner_org.registered`. An unknown type, a conflicting vertical or an invalid fact returns 400 with no insert. A client can never set `lifecycle_state`, `trust_level` or `status`. Registrations without `partner_type` behave exactly as before.
TEST: services/gateway/test/partner-orgs.test.ts

AC-5 The DB trigger keeps both writers working.
- Legacy status-only writes derive the lifecycle:
  - `/register` (`pending_review`) gives `draft`;
  - `/activate` (`active`) gives `live`.
- Lifecycle writes set the status.
- `commerce_vertical` cannot drift from `partner_type`.
- Invalid values are rejected.

Verified against a local PostgreSQL 16 cluster, not the live project (`outputs/local-postgres16-trigger-behaviour.txt`).
TEST: services/gateway/test/vtid-04471-partner-account-model.test.ts

AC-6 The two migrations are idempotent and the backfill is correct:
- every owned merchant or connection is linked to its owner's existing org, or to a new one-member `draft` org with the owner as `org_admin`;
- network merchants and non-uuid owners are left unlinked;
- `down.sql` rolls the Prisma migration back.

Verified locally (`outputs/local-postgres16-apply-backfill.txt`). On the live project, read-only on 2026-09-24, there were 0 orgs, 0 owned merchants and 0 `partner_tenant` rows, so the backfill changes no live rows.
TEST: services/gateway/test/vtid-04471-partner-account-model.test.ts

## OASIS

OASIS_IMPACT: yes. `partner_org.registered` gains a `partner_type` field in its payload (null when the field was not sent). No topic is added or removed.

OASIS_PROOF: the route test asserts the payload
(`services/gateway/test/partner-orgs.test.ts`, `payload: objectContaining({ partner_type: 'practitioner_clinic' })`).
Once this is deployed, check it with:
`SELECT topic, metadata->>'partner_type' FROM oasis_events WHERE topic = 'partner_org.registered' ORDER BY created_at DESC LIMIT 5;`

## Order of operations

`/register` and `/mine` select the new columns. **Both migrations were applied to the live project on 2026-09-24, before merge, on the platform owner's go-ahead** (`outputs/live-apply-postcheck.txt`). Merging deploys staging, and staging reads the production database, so it would fail on columns that do not exist yet. Apply the Supabase migration first, then the Prisma one (its FK references `partner_organizations`).

## Not in this VTID

- The org role rename (`owner` / `admin` / `manager` / `practitioner`, spec §5.3).
- The onboarding engine API and the automatic transitions (spec §6).
- Making the VCAOP portal set `partner_organization_id` when it creates a merchant or connection.
