# Google OAuth client status (read-only check, 2026-10-06)

`GET https://preview-aws-gateway.vitanaland.com/api/v1/social-accounts/providers`
→ `{"provider":"google","name":"Google","configured":false}` (also false for microsoft).

No Google OAuth client exists on staging; per docs/CONNECTED-APPS-OAUTH-SETUP.md (checked 2026-09-24) none on production either.
With CALENDAR_GOOGLE_SYNC_ENABLED=true and no client, `calendar-google-sync.ts:44-45` returns `not_configured`; nothing syncs until the operator
provisions the client (scripts/aws/setup-connected-apps-oauth-secrets.sh) and sets PROD_GOOGLE_OAUTH_CLIENT_ID_ARN / _SECRET_ARN.
Production was not probed.
