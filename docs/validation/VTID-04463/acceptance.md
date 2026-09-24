# VTID-04463 — Commerce partner onboarding Phase 1: email partner-org invites

Phase 1 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` (VTID-04330).
Until now, `POST /api/v1/partner-orgs/:orgId/members/invite` created an invite
row and nobody was told about it. The invitee only learned of it if someone at
Vitana passed the token on. That defeats self-service onboarding.

## What changed

- `services/email/resend-mailer.ts`: the gateway's first outbound email sender.
  It makes one POST to Resend's HTTP API with plain `fetch`, has an 8 s
  timeout, never throws, and returns `not_configured` unless `RESEND_API_KEY`
  and `EMAIL_FROM` are both set.
- `services/email/partner-invite-email.ts`: builds the localised invite email
  from gateway catalog keys (`email.partner_invite.*`, all locales except
  `ar`, which falls back to EN). Gated on `PARTNER_INVITE_EMAIL_ENABLED`, which
  must be exactly `true`.
- `routes/partner-orgs.ts`: the invite route sends the email after the insert,
  best effort.
  - A send failure never fails the invite.
  - The response now carries `accept_url` so an admin can share the link by
    hand, plus `email: {sent, status}`.
  - The provider's error text is logged, never returned.
  - The `partner_org.member_invited` payload gains `email_status`.

## Acceptance criteria

AC-1 An invite is created and returns 201 whether the email is sent, disabled or throws. The response carries `accept_url` (`<APP_BASE_URL>/commerce/invites/<token>/accept`) and `email.status`, and never echoes a provider error.
TEST: services/gateway/test/partner-orgs.test.ts

AC-2 When enabled, the route sends the email to the invited address. The inputs are the org display name, the role, the accept link with the 48-hex token, a validity of 7 days and the inviter's locale. The OASIS payload records `email_status`. A failed insert sends nothing.
TEST: services/gateway/test/partner-orgs.test.ts

AC-3 The mailer sends nothing and returns `not_configured` unless both `RESEND_API_KEY` and `EMAIL_FROM` are set. When configured it POSTs `https://api.resend.com/emails` with `Authorization: Bearer <key>` and `{from, to:[addr], subject, html, text, tags}`.
TEST: services/gateway/test/vtid-04463-partner-invite-email.test.ts

AC-4 The mailer maps a Resend 4xx to `rejected`, a 5xx to `failed`, and a network error or timeout to `failed`. It never throws, and every request carries an abort signal.
TEST: services/gateway/test/vtid-04463-partner-invite-email.test.ts

AC-5 The email is localised: EN and German du-form, no unfilled `{placeholder}`. The org name is HTML-escaped in the HTML part. The feature flag accepts only the exact string `true`.
TEST: services/gateway/test/vtid-04463-partner-invite-email.test.ts

AC-6 The new catalog keys exist in every locale the coverage test checks, with preserved placeholders.
TEST: services/gateway/test/i18n/catalog-coverage.test.ts

## OASIS

OASIS_IMPACT: yes. `partner_org.member_invited` gains an `email_status`
field. The value is one of `sent`, `disabled`, `not_configured`, `rejected` or
`failed`. There is no new topic.

## Not verified here

- No real email was sent. There is no Resend key in this session, and staging
  shares the production database, so an invite created there reaches a real
  inbox (CLAUDE.md absolute rule).
- The feature ships inert. The owner has to take four steps before it does
  anything:
  1. Create a Resend API key.
  2. Verify the sending domain in Resend.
  3. Store the key in AWS Secrets Manager and wire it into the task
     definition.
  4. Set `EMAIL_FROM` and `PARTNER_INVITE_EMAIL_ENABLED=true`.

## Not in this VTID

- The partner account model and the onboarding engine (spec §5–§6).
- Deploy-workflow wiring of `RESEND_API_KEY`. The staging secrets loop fails
  the whole deploy if a listed secret does not exist yet (Fish precedent).
