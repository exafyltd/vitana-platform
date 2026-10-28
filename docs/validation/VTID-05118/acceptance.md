# VTID-05118 — Welcome-discount emails: trigger posts with the email trigger secret (platform part)

Owner approval 2026-10-12 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds).
Two repos: this PR carries the migration, its test and this pack; the exafyltd/vitana-v1 PR (same VTID) carries
`supabase/functions/_shared/trigger-secret.ts`, the `caller-auth.ts` re-export, the edge-function guard and the Vitest
tests. **Order: the vitana-v1 edge function is deployed first, then this migration is applied** via
`RUN-MIGRATION.yml` (otherwise the new trigger posts get 401).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none — no gateway route changes. The change is one database function (`public.notify_welcome_discount()`).

OASIS_PROOF: none — no event emitted or changed.

## Acceptance criteria

AC-1: `public.notify_welcome_discount()` is redefined (only it; the trigger is unchanged) to read vault
`email_trigger_secret` and post to the public `send-welcome-discount` URL with an `X-Trigger-Secret` header and body
`{discount_code_id}`.
  TEST: services/gateway/test/vtid-05118-welcome-discount-trigger-secret.test.ts (8 passed; 5 of them fail against the old definition, incl. the EXECUTE revoke, see commands.log)

AC-2: The migration no longer references the missing vault names `'supabase_url'` / `'service_role_key'`, carries no
authorization header and no secret value (no `eyJ`, no `sb_secret_`).
  TEST: services/gateway/test/vtid-05118-welcome-discount-trigger-secret.test.ts

AC-3: A missing vault secret skips the call with a WARNING and `RETURN NEW` before `net.http_post`; the outer
`EXCEPTION WHEN OTHERS` stays, so a signup is never blocked. `SECURITY DEFINER` and `search_path = public` stay.
  TEST: services/gateway/test/vtid-05118-welcome-discount-trigger-secret.test.ts

AC-4: After apply (read-only, by the orchestrator): `pg_get_functiondef('public.notify_welcome_discount'::regproc)`
contains `email_trigger_secret` and not `service_role_key`; `SELECT count(*) FROM vault.secrets WHERE
name='email_trigger_secret'` = 1 (name only, no value read).
  TEST: post-apply read-only SELECTs listed in commands.log (to run after RUN-MIGRATION.yml)

AC-5: End to end (observation only, no signup and no POST created for it): at the next organic Maxina signup,
`net._http_response` shows status 200 for the request and the `send-welcome-discount` logs show
`[SEND-WELCOME-DISCOUNT] Email sent successfully`.
  TEST: read-only observation of net._http_response and edge-function logs after the next organic signup

AC-6: The new markdown in this pack carries no credential material.
  TEST: services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts (1402 passed)
