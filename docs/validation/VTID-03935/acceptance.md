# VTID-03935 — Commerce Partner Onboarding: GET /mine + GET /:orgId/invites listing endpoints

## Report

Phase 2 (frontend, `exafyltd/vitana-v1`) planning for VTID-03932's Commerce
Partner Onboarding surfaced two gaps in Phase 1's own backend contract: a
caller has no way to discover which org(s) they belong to (no `orgId` to
look up `GET /:orgId/members` with), and an org_admin has no way to see
pending (not yet accepted) invites for their org. Both are small additions
to the file Phase 1 already owns
(`services/gateway/src/routes/partner-orgs.ts`), shipped in the same PR
(#3331) rather than a separate one, since the migration/tests/evidence pack
already there covers the same tables.

- `GET /api/v1/partner-orgs/mine` — auth required, no org-admin gate (any
  member reading their own memberships). Joins
  `partner_organization_members` → `partner_organizations` via Supabase's
  embedded-resource select (same pattern `admin-partner-health.ts` already
  uses for `partner_registry(display_name)`), returns
  `{ok, organizations: [{id, org_key, display_name, org_type, status, role}]}`.
- `GET /api/v1/partner-orgs/:orgId/invites` — `requireOrgAdmin()`-gated
  (the same middleware factory `partner-orgs.ts` already has). Returns
  `{ok, invites: [{id, email, role, expires_at, accepted_at}]}`,
  newest-first.

## Acceptance Criteria

AC-1 — `GET /mine` returns every org the caller is a member of, with their
role in each, correctly unwrapping the embedded join; returns an empty
list for a caller with no memberships.

TEST: `test/partner-orgs.test.ts` — describe "GET /mine" (2 tests).

AC-2 — `GET /:orgId/invites` is org_admin-or-exafy_admin-gated (403
otherwise) and returns the org's pending/accepted invites.

TEST: same file — describe "GET /:orgId/invites" (2 tests).

AC-3 — `tsc` produces no new errors attributable to these two routes.

TEST: narrow `tsc --noEmit` run, `outputs/gateway-tsc-narrow.txt` — same
sandbox-noise-only shape as VTID-03932's own run.

## Not verified / blocked

Same as VTID-03932 (same PR, same unapplied migration): no live Supabase
access to exercise these routes against the real `partner_organization_*`
tables, which don't exist yet pending the platform owner's "apply now."
No jest execution in this sandbox — traced by hand against the same
fake-Supabase harness `partner-orgs.test.ts` already established.
