# VTID-04478 — Commerce partner onboarding Phase 1: onboarding engine API

Phase 1 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` (VTID-04330),
§6.1 checklist and §6.2 API. This is the core engine: it computes each org's
checklist from its partner type and moves the lifecycle itself. There is no
admin call on the path from `draft` to `live`.

## What changed

- **`services/partner-onboarding-checklist.ts`** (pure):
  - the required steps per partner type, from the spec §6.1 table;
  - the verification level each type needs (§7);
  - the derived steps: account, company (VAT id required only inside the EU), terms (current version only) and team;
  - stored steps for everything else;
  - `next_step`, `submit_ready`, and the engine verdict (`live` or `needs_action`, naming the open steps);
  - the ordered transitions `submit` makes.
- **`routes/partner-onboarding.ts`**, mounted at `/api/v1/partner-onboarding`:
  - `POST /start`: an email is required; idempotent per user and type while the org is a draft.
  - `GET /:orgId`: org_admin only.
  - `PATCH /:orgId/company`: locked once the org is submitted.
  - `POST /:orgId/terms/accept`: only the version in `PARTNER_TERMS_VERSION`; records user, time, IP and user agent once.
  - `POST /:orgId/submit`: checks prerequisites, then makes guarded transitions through `canTransition`, with one `partner_org.lifecycle_changed` event per move.
- **Migration `20260924150000_vtid_04478_partner_onboarding_engine.sql`:** tables `partner_onboarding_steps` and `partner_terms_acceptances`, RLS with member SELECT, writes revoked from browser roles.
- **`requireOrgAdmin` / `getCallerId` / `isExafyAdmin`** are exported from `routes/partner-orgs.ts` so both routers use the same guard.

## Acceptance criteria

AC-1 Each partner type requires exactly the steps in spec §6.1. `team` is never required. A step a type does not need reads `not_required`.
TEST: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts

AC-2 The derived steps come from facts, never from a stored row:
- company names its missing fields, and needs a VAT id only inside the EU;
- terms is done only for the version in force, and reads `terms_not_published` when none is set;
- team is done once the org has more than one member.
TEST: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts

AC-3 The engine verdict is `live` when every required step is done, and otherwise `needs_action` naming the open and failed steps. `submit` plans only transitions that `canTransition` allows, and only from `draft` or `needs_action`.
TEST: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts

AC-4 `POST /start` refuses a caller without an email. It creates a `draft` org with the caller as `org_admin`, emits `partner_org.onboarding_started`, never returns `owner_user_id`, and returns the existing draft instead of creating a second one.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-5 `PATCH /company` stores normalised facts while the org is `draft` or `needs_action` and emits `partner_org.company_updated` with the field names only (never the values), returns `COMPANY_LOCKED` otherwise, and returns 400 on an invalid fact. `GET /:orgId` is org_admin only.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-6 Terms acceptance returns 503 when no terms are published and 409 for any version but the current one. It records organization, version, user, IP and user agent, emits `partner_org.terms_accepted`, and treats a repeat acceptance as already done without a second event.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-7 `submit`:
- returns 409 with the missing prerequisites and makes no transition;
- otherwise moves `draft → submitted → verifying → needs_action`, or `→ live` with no admin call when every required step is done;
- re-submits from `needs_action`;
- refuses from any other state;
- guards every update on the state it leaves, stopping with `CONCURRENT_UPDATE` and no event if another request moved the org first;
- emits one `partner_org.lifecycle_changed` per move.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-8 The stored step keys in the migration are exactly the non-derived steps. The migration is idempotent and rejects derived step keys, unknown statuses and a second acceptance of the same version (`outputs/local-postgres16-migration.txt`, run against a local scratch cluster, never the live project).
TEST: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts

## Route mount

ROUTE_MOUNT: `services/gateway/src/index.ts`, `mountRouterSync(app, '/api/v1/partner-onboarding', partnerOnboardingRouter, { owner: 'partner-onboarding' })`.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/start` (staging, after merge).
CURL_PROOF: **not yet run.** The route is new and deployed nowhere, so a response written down now would be invented.
- **Before merge:** `test/partner-onboarding.test.ts` mounts the real router with supertest. Without a token it returns `401 application/json`, and it covers every handler.
- **After the staging deploy:** `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/start` should return `401 application/json`. A `404 text/html` would mean it did not deploy.
CURL: see CURL_PROOF above.

## OASIS

OASIS_IMPACT: yes. Four new topics:
- `partner_org.onboarding_started`
- `partner_org.company_updated` (payload: the field names changed, never the values)
- `partner_org.terms_accepted`
- `partner_org.lifecycle_changed` (payload `from`, `to`, `reason`, and on `needs_action` also `open_steps` and `failed_steps`)

OASIS_PROOF: the route suite asserts each event, including one `lifecycle_changed` per move with the `needs_action` payload, and that no event is emitted on a refused or concurrent submit. Once deployed, check with:
`SELECT topic, metadata->>'from', metadata->>'to' FROM oasis_events WHERE topic LIKE 'partner_org.%' ORDER BY created_at DESC LIMIT 10;`

## Order of operations

Apply the migration to the live project before merge. The Migration Drift Check refuses a table declared in a migration that does not exist live.

## Not in this VTID

- The remaining §6.2 endpoints: detect, catalogue, connections, tracking test, DPA, billing mandate and verification. Each writes its step row when it lands.
- Automatic `exception` outcomes, and computing `trust_level`: there are no checks yet that produce them.
- The transition emails to org admins (§13).
- The frontend (the wizard and the assistant).
- Publishing the partner terms: until `PARTNER_TERMS_VERSION` is set, no org can reach `submit`.
