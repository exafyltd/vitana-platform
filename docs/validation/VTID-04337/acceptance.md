# VTID-04337 — Commerce partner onboarding Phase 1: security fixes

Phase 1 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` (VTID-04330),
defects SEC-1, SEC-2 and SEC-3 from its §3.3.

## What was wrong

- **SEC-1:** `POST /api/v1/partner-orgs/invites/:token/accept` never compared the caller with the invited address, so anyone holding the link joined with the invited role.
- **SEC-2:** the `partner_organization_members` SELECT policy queried its own table. It fails live with 42P17 for every browser read (`outputs/live-rls-recursion-before.txt`). The `partner_organizations` policy re-entered it for any non-owner member.
- **SEC-3:** `POST /api/v1/partner-orgs/:orgId/activate` updated `status='active'` unconditionally, so a `rejected` org could be activated.

## Acceptance criteria

AC-1 Accepting an invite requires the caller's JWT email to equal the invited email, compared case-insensitively and ignoring surrounding whitespace. On a mismatch the endpoint returns 403 `INVITE_EMAIL_MISMATCH`, writes no member row, emits no `member_joined` event, and does not echo the invited address.
TEST: services/gateway/test/partner-orgs.test.ts

AC-2 An identity without an email cannot accept an invite: 403 `INVITE_EMAIL_UNVERIFIED`.
TEST: services/gateway/test/partner-orgs.test.ts

AC-3 The existing accept contract is unchanged for the invitee: 404 unknown token, 409 already accepted, 410 expired, 200 happy path.
TEST: services/gateway/test/partner-orgs.test.ts

AC-4 Activation is conditional on the current status: the UPDATE carries `status IN ('pending_review','suspended','active')`. A `rejected` org returns 409 `ORG_NOT_ACTIVATABLE` with its current status and emits no `partner_org.activated` event. A missing org still returns 404, and re-activating an active health org stays the idempotent no-op the registry bridge relies on.
TEST: services/gateway/test/partner-orgs.test.ts

AC-5 The members SELECT policy and the organizations SELECT policy check membership through `public.is_partner_org_member(uuid)`. That helper is SECURITY DEFINER with a pinned `search_path`, answers only for the calling user, and is executable only by `authenticated` and `service_role`. Neither policy selects from `partner_organization_members` directly.
TEST: services/gateway/test/vtid-04337-partner-org-members-rls-no-recursion.test.ts

AC-6 After the migration is applied, the same read-only probe as `outputs/live-rls-recursion-before.txt` returns a count instead of 42P17. It is recorded in `outputs/live-rls-after.txt` once applied.
TEST: services/gateway/test/vtid-04337-partner-org-members-rls-no-recursion.test.ts

## OASIS

OASIS_IMPACT: no. No new or changed event topics. The existing `partner_org.member_joined` / `partner_org.activated` events are now simply not emitted on the refused paths.

## Not in this VTID

- Emailing invites.
- The partner account model and the onboarding engine (spec §5–§6).

Both are the next Phase 1 PRs.
