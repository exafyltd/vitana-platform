# VTID-04507 — Connected Apps sign-in wiring on staging

## Report

On staging every Connected Apps row except Android Contacts showed "Not
available yet" with a disabled switch. Read-only checks on 2026-09-24:

- `GET /api/v1/connected-apps` (staging): 9 of 10 apps `not_configured`.
- `GET /api/v1/social-accounts/providers`: `google:false`, `microsoft:false`
  on staging and on production — no Google or Microsoft OAuth client exists
  anywhere yet.
- The staging workflow sets neither `GATEWAY_PUBLIC_URL` nor `APP_URL`, so the
  OAuth `redirect_uri` and the post-consent return would both have been built
  on `https://vitana.app` even with a client configured.

This VTID pins both URLs on staging, wires the five sign-in secrets when they
exist, ships the script that creates them and a setup guide for the Google
Cloud Console and Azure portal. The client registrations themselves are the
owner's (they need the company's Google and Microsoft accounts).

## Acceptance Criteria

AC-1 — The staging deploy pins `GATEWAY_PUBLIC_URL=https://preview-aws-gateway.vitanaland.com`
and `APP_URL=https://preview-aws.vitanaland.com`.
TEST: services/gateway/test/vtid-04507-staging-connected-apps-oauth-wiring.test.ts

AC-2 — `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `MICROSOFT_OAUTH_CLIENT_ID/SECRET` and
`AI_CREDENTIALS_ENC_KEY` are wired as ECS secrets only when
`vitana/gateway/staging/…` exists; an absent secret is logged and never fails
the deploy.
TEST: services/gateway/test/vtid-04507-staging-connected-apps-oauth-wiring.test.ts

AC-3 — The merge replaces stale values, strips a same-named plain env entry
(ECS rejects a name in both lists) and keeps everything else.
TEST: services/gateway/test/vtid-04507-staging-connected-apps-oauth-wiring.test.ts

AC-4 — The task-definition step stays under GitHub's 20,000-character run
limit and passes `bash -n`.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5 — Production is untouched.
TEST: services/gateway/test/vtid-04507-staging-connected-apps-oauth-wiring.test.ts

## Not verified

The live effect needs the secrets, which this session cannot create
(no AWS credentials here; sessions have no `secretsmanager:CreateSecret`).
After the owner runs `scripts/aws/setup-connected-apps-oauth-secrets.sh` and
the next staging deploy, `/api/v1/social-accounts/providers` should report
`google:true` / `microsoft:true`.
