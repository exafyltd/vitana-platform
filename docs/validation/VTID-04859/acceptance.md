# VTID-04859 — Founding 1000: a free Premium year for the first 1,000 members

Phase 2 of the engagement & rewards plan (owner decisions 2026-10-01,
`docs/business-model/BUSINESS-MODEL.md` §11). Companion PR in
`exafyltd/vitana-v1` (same VTID): the celebration screen.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/index.ts — the existing billing router (`require('./routes/billing').default`, mounted at `/api/v1/billing`); this PR adds two routes to it, no new mount.
FINAL_URL: GET /api/v1/billing/founding/me (requireAuth) · POST /api/v1/billing/founding/celebrated (requireAuth) · GET /api/v1/billing/founding-status (public, existing route, now reads founding_members)
CURL_PROOF: after the staging deploy STAGING-VERIFY runs docs/validation/VTID-04859/staging-tests.json — unauthenticated `GET /api/v1/billing/founding/me` answers JSON 401, `GET /api/v1/billing/founding-status` answers JSON with `"max_uses":1000`, and an unsigned `POST /api/v1/billing/founding/celebrated` answers 401 (rejected probe; nothing is written). The signed-in read is covered by the community-app staging spec. Not run from the authoring session: the routes are not deployed until this merges.

## Acceptance criteria

AC-1: Seats 1..1000 are assigned in signup order, one per member, serialised; seat 1,001 is SOLD_OUT and the signup still succeeds.
  TEST: supabase/tests/vtid_04859_founding_1000.test.sql
  TEST: services/gateway/test/vtid-04859-founding-1000.test.ts
AC-2: A member without a subscription gets Premium until max(current end, now + 365 days); a Stripe subscription is never overwritten; the 12-month launch grant is kept and not extended.
  TEST: supabase/tests/vtid_04859_founding_1000.test.sql
AC-3: Registered test/service accounts (service_bot_accounts, notification_test_actors, the system bot) never get a seat (CLAUDE.md rules 43-45); the migration refuses to commit otherwise.
  TEST: supabase/tests/vtid_04859_founding_1000.test.sql
AC-4: New members are seated at signup by a trigger on user_tenants that can never block the membership insert; existing members are backfilled in signup order; re-running the migration changes nothing.
  TEST: supabase/tests/vtid_04859_founding_1000.test.sql
AC-5: GET /api/v1/billing/founding/me (auth) reports the seat, the year, EUR 119.88 and whether the celebration was shown; a database error is a 500, never a silent "no seat".
  TEST: services/gateway/test/routes/billing-founding.test.ts
AC-6: POST /api/v1/billing/founding/celebrated (auth) records the celebration once and emits billing.founding.celebrated; non-members get 404.
  TEST: services/gateway/test/routes/billing-founding.test.ts
AC-7: GET /api/v1/billing/founding-status reports seats taken of 1,000 with no code; the FOUNDING code (500 / 90 days) is deactivated.
  TEST: services/gateway/test/routes/billing-founding.test.ts
  TEST: supabase/tests/vtid_04859_founding_1000.test.sql

ACCEPTANCE: AC-1..AC-7 above, each mapped to a test.
MERGE_PAYLOAD_PREVIEW: migration `20261003100000_vtid_04859_founding_1000.sql` (one new table, three functions, one trigger, backfill, FOUNDING code deactivated) — applied via RUN-MIGRATION.yml after approval and BEFORE this merges, so the new routes find their table; gateway: two new billing routes, founding-status reads seats; docs.
OASIS_IMPACT: yes

OASIS_PROOF: POST /api/v1/billing/founding/celebrated emits `billing.founding.celebrated` (vtid VTID-04859, source billing, actor = the member, payload celebrated_at) after mark_founding_celebrated succeeds, and nothing when the member has no seat — asserted in services/gateway/test/routes/billing-founding.test.ts. The event type is declared in services/gateway/src/types/cicd.ts.

## Rollout order

1. Approve and apply the migration (RUN-MIGRATION.yml). Live effect: every
   existing member gets a seat in signup order; members with no subscription
   (137 of 231 on 2026-10-03) get Premium for a year; the 94 launch-grant
   members keep their year; registered test accounts get nothing.
2. Merge this PR (gateway to staging), then the vitana-v1 PR.
3. STAGING-VERIFY, ready message, PUBLISH.

## Scope

SCOPE_ALLOWLIST:
- supabase/migrations/20261003100000_vtid_04859_founding_1000.sql
- supabase/tests/vtid_04859_fixture.sql
- supabase/tests/vtid_04859_founding_1000.test.sql
- scripts/ci/test-vtid-04859-founding.sh
- services/gateway/src/routes/billing.ts
- services/gateway/src/routes/billing-repository.ts
- services/gateway/src/types/cicd.ts
- services/gateway/test/**
- DATABASE_SCHEMA.md
- docs/validation/VTID-04859/**
