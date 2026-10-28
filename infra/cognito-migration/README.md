# Cognito auth migration (VTID-03827)

**Status: scaffolded, NOT applied, NOT tested against a live Cognito pool.**
Nothing in this directory has been run against real AWS infrastructure.

## Why this exists

The platform owner decided (2026-08-25, per `docs/SUPABASE-TO-AURORA-
MIGRATION-PLAN.md`, "Option B / B4 — Identity") to move authentication off
Supabase Auth (GoTrue) entirely, with a stated **20 September 2026**
deadline. As of this VTID, that work was completely unstarted — zero code —
despite the Aurora data migration itself (the rest of this repo's
`docs/AURORA-MIGRATION-STATUS-2026-09-10.md`) having reached 585/585 tables
verified. Auth, not data, is now the actual blocker to any real cutover.

Scope, quoted from the plan doc: 209 real users' credentials, 194 frontend
auth call sites, 638 RLS policies keyed on `auth.uid()`/`auth.jwt()`, 74
edge functions, 79 realtime subscriptions. The plan doc's own words: **"a
multi-quarter programme, not a migration."** This directory is a first,
partial slice of it — the identity provider itself — not the whole thing.

## Why Cognito, and why a User Migration Lambda specifically

- Cognito's bulk CSV `CreateUserImportJob` does **not** accept bcrypt
  password hashes. There is no bulk-import path that avoids forcing all 209
  users to reset their password.
- The alternative Cognito actually supports for this exact situation is the
  **User Migration Lambda trigger** (`lambda/index.js`, wired in
  `lambda.tf`): lazy, one user at a time, on their next real login attempt
  (or Forgot Password). Cognito calls the Lambda, the Lambda verifies the
  password against the legacy system, and Cognito silently creates the
  account at that moment if it succeeds. No forced reset, no bulk export of
  password hashes anywhere.
- This corrects an imprecise claim in `SUPABASE-TO-AURORA-MIGRATION-
  PLAN.md`'s B4 section ("Cognito supports bcrypt import") — it doesn't;
  the Lambda trigger is the real mechanism, and is what's implemented here.
- The Lambda verifies credentials by calling **GoTrue's own password-grant
  endpoint** (`POST {SUPABASE_URL}/auth/v1/token?grant_type=password`),
  the same endpoint `services/gateway/src/routes/auth.ts` already proxies
  to — not by re-implementing bcrypt comparison against
  `auth.users.encrypted_password` directly. That means this Lambda never
  needs a direct Postgres credential for the common (Authentication)
  path — only the same anon key already shipped to every frontend client.
  The rarer ForgotPassword path has no password to check and instead calls
  GoTrue's Admin API (`/auth/v1/admin/users`) to confirm the account
  exists, which does need the `service_role` key — kept in Secrets Manager,
  resolved by the Lambda at runtime, never in a plain env var or tfvars
  file (see `variables.tf`'s `supabase_service_role_secret_arn`).
- Confirmed live 2026-09-12: Supabase GoTrue uses standard bcrypt,
  `$2a$10$` prefix (10 rounds) — `select encrypted_password from
  auth.users limit 3`. Consistent with everything above; not itself used
  by the Lambda, since verification goes through GoTrue's API instead of
  reading the hash directly.

## What's in this directory

| File | Purpose |
|---|---|
| `versions.tf` | `aws` + `archive` providers. No backend wired yet (see below). |
| `variables.tf` | `name_prefix`, `region`, Supabase URL/anon key, service-role secret ARN, tags. |
| `cognito.tf` | The User Pool + App Client. Email-username, lazy-migration-only user creation (`allow_admin_create_user_only = true` — no public self-registration through this pool while both systems are live, to avoid a genuinely-new signup racing a not-yet-migrated legacy account for the same email). |
| `lambda.tf` | The User Migration Lambda function, its execution role (basic-exec + a `secretsmanager:GetSecretValue` policy scoped to exactly one secret ARN, never a wildcard), and the `lambda:InvokeFunction` permission Cognito needs to call it. |
| `lambda/index.js` | The trigger implementation — see comments in the file itself for the Authentication vs. ForgotPassword branches. |
| `outputs.tf` | Pool ID/ARN/endpoint, app client ID, Lambda ARN/name — the gateway and frontend will need these once real values exist. |
| `examples/*.tfvars` | Placeholders, not real values. Never commit a real secret ARN or key value into a tracked tfvars file. |

## THE BLOCKER — read this before assuming this can just be applied

**This session's AWS IAM identity cannot create any Cognito resource, at
all, and this is by deliberate administrator design, not a fixable bug or
a Claude Code permission prompt.**

Confirmed live, 2026-09-12, against `arn:aws:iam::472838866351:user/
claude-code-aws-agent`:

```
$ aws cognito-idp list-user-pools --region eu-central-1 ...
AccessDeniedException

$ aws iam list-attached-user-policies --user-name claude-code-aws-agent
$ aws iam list-user-policies --user-name claude-code-aws-agent
```
Both explicitly denied — the error names an explicit deny inside a
**permissions boundary**, `arn:aws:iam::472838866351:policy/
claude-code-aws-agent-boundary`, attached to this IAM user. The boundary
denies `cognito-idp:*` outright, and even denies this identity from
listing its *own* attached policies, so the exact shape of the boundary
can't be introspected from here either.

This is categorically different from every other blocker this migration
has hit so far (VTID-03448 through VTID-03826's chat-layer "auto mode
classifier" prompts, all of which a user could resolve by running the
same command themselves in their own CloudShell session, under their own
credentials). **A permissions boundary is an AWS IAM control, evaluated
server-side by AWS, before any Claude Code chat-level authorization is
even in the picture.** No amount of "you have all permissions, go ahead"
in this conversation changes what AWS itself will accept from this IAM
user's credentials. This needs a human with real IAM admin rights to do
one of:

1. **Widen the boundary** to allow `cognito-idp:*` (and `lambda:*`,
   `iam:CreateRole`/`PutRolePolicy` scoped to this migration's role names,
   `secretsmanager:CreateSecret`/`GetSecretValue` scoped similarly) for
   this session's IAM user, then hand control back to apply this module
   from here; **or**
2. **Apply this module themselves** (or via a CI identity that already has
   the needed permissions) and hand back the resulting `user_pool_id`,
   `user_pool_client_id`, and Lambda ARN so the application-layer
   integration (gateway JWT verification, RLS shim, frontend rewrite) can
   proceed from those real values.

Until one of those happens, treat the Cognito side of this migration as
**blocked on infrastructure access, not on remaining design or code work**.

## Before running `terraform apply` (once the blocker above is resolved)

1. `cd infra/cognito-migration/lambda && npm install --production` — the
   Lambda depends on `@aws-sdk/client-secrets-manager`; `archive_file`
   zips whatever is on disk in `lambda/`, so the dependency must be
   installed first or the ForgotPassword path will fail at runtime with a
   module-not-found error the first time it's actually invoked.
2. Create the `supabase_service_role_secret_arn` secret first:
   ```
   aws secretsmanager create-secret --name vitana-staging/supabase-service-role \
     --secret-string '<the service_role key>' --region eu-central-1
   ```
   Never put the raw key in a tfvars file or in Lambda console/CLI
   `--environment` output — only its ARN.
3. Wire an S3 backend (`versions.tf` has the commented block) before the
   first real `apply` — right now this module has no remote state at all,
   which is fine for a `plan`-only review but not for anything applied for
   real, twice, by different people.
4. `terraform plan -var-file=examples/staging.tfvars` (after filling in
   real values in a **non-committed** copy) — review carefully, this is a
   real AWS account.

## Gateway token verification — DONE (additive, inert until configured)

`services/gateway/src/middleware/auth-supabase-jwt.ts` now has a third
verification path (VTID-03827), tried after the existing HS256/ES256
Supabase paths fail: it verifies a Cognito-issued **ID token** (not access
token — Cognito access tokens carry no email/custom claims) as RS256
against the pool's JWKS, requires `token_use === 'id'`, and optionally
checks `aud` against `COGNITO_APP_CLIENT_ID` when that's set. Gated on
`COGNITO_USER_POOL_ID` — unset (as it is everywhere today, since no pool
exists yet), it's a complete no-op, exactly like `SUPABASE_AUTH_JWKS_URL`'s
existing pattern.

New env vars this reads (none set on any live task def yet — set them once
the User Pool above is actually applied):

| Var | Required | Purpose |
|---|---|---|
| `COGNITO_USER_POOL_ID` | yes (gates the whole path) | e.g. `eu-central-1_XXXXXXXXX` — the `user_pool_id` output above |
| `COGNITO_REGION` | no (falls back to `AWS_REGION`, then `eu-central-1`) | region the pool lives in |
| `COGNITO_APP_CLIENT_ID` | no, but strongly recommended | the `user_pool_client_id` output above — without it, any client of this pool's tokens is accepted, not just the vitana app |

**Identity mapping — the important part.** `extractCognitoIdentity()` reads
`user_id` from the token's `custom:legacy_user_id` claim, NOT Cognito's own
`sub`. This is why `cognito.tf`'s User Pool schema carries that custom
attribute and why the migration Lambda populates it from the Supabase
user's `id` at migration time (see `lambda/index.js`'s
`buildUserAttributes()`) — every existing FK, RLS policy, and
`app_users`/`user_tenants` row is keyed on the Supabase id, and Cognito's
own `sub` is a fresh random UUID that has no relationship to any of that.
Losing this claim would silently disconnect a migrated user from all their
existing data despite a "successful" login.

**Still an open gap, deliberately not silently glossed over:**
`exafy_admin` is hardcoded `false` for every Cognito-authenticated
identity — there is no Cognito-side source of truth for it yet (no custom
claim, no group). `requireExafyAdmin`/`requireAdminAuth` will therefore
incorrectly reject a real admin who has been migrated to Cognito, until
this gets either its own custom claim (mirroring `legacy_user_id`, set by
the migration Lambda from the legacy `app_metadata.exafy_admin` value) or
a DB-lookup fallback the way `requireTenant` already has for `tenant_id`.
Flagged in-code (`extractCognitoIdentity`'s doc comment) so it can't be
missed by a future reader. `tenant_id` has no equivalent gap — it already
resolves correctly for a Cognito identity via `requireTenant`'s existing
`user_tenants` DB lookup, since that lookup is keyed on `user_id`, which is
now the correct (legacy) id regardless of which provider signed the token.

New tests: `services/gateway/test/middleware/auth-supabase-jwt.test.ts`,
`describe('Cognito RS256 JWT verification (VTID-03827)')` — verifies the
legacy-id mapping, the sub fallback, `token_use` and `aud` rejection.

## Gateway auth proxy routes (`/login`, `/refresh`) — DONE (additive, inert until configured)

`services/gateway/src/routes/auth.ts`'s `POST /login` and `POST /refresh`
now branch on `isCognitoAuthConfigured()` (same gate as the JWT verification
path — `COGNITO_USER_POOL_ID` + `COGNITO_APP_CLIENT_ID`) via a new
`services/gateway/src/services/cognito-auth-client.ts`, wrapping
`InitiateAuth` (`USER_PASSWORD_AUTH` for login, `REFRESH_TOKEN_AUTH` for
refresh). **The frontend's request/response shape at these two endpoints
does not change either way** — that's the point of a gateway PROXY: a
client that already calls `POST /auth/login` with `{email, password}` and
reads back `{access_token, refresh_token, user}` keeps working unmodified
whichever identity provider is behind it. `GET /auth/health` now also
reports `cognito_configured`/`active_login_provider` so this is observable
without reading env vars directly.

What `cognitoLogin()`/`cognitoRefresh()` return as `access_token` is
Cognito's **ID token**, not its AccessToken — deliberately, because that's
the only Cognito token type carrying the `custom:legacy_user_id`/`email`
claims the gateway's JWT verification path (above) needs, and because
Cognito access tokens can't carry custom claims at all. A user's very
first successful `/login` attempt is also what triggers the User Migration
Lambda behind the scenes (Cognito calls it automatically mid-`InitiateAuth`
for an email it doesn't have a user record for yet) — no separate
migration step or endpoint is needed on the gateway side.

**Deliberately not implemented: `RespondToAuthChallenge`.** This pool's
design (`allow_admin_create_user_only = true`, users only ever created by
the migration Lambda with `finalUserStatus: 'CONFIRMED'`) means a login
challenge — `NEW_PASSWORD_REQUIRED`, MFA, etc. — should never occur in
practice. If `InitiateAuth` ever returns a `ChallengeName` instead of
tokens, `cognito-auth-client.ts` surfaces an explicit `CHALLENGE_REQUIRED`
error rather than silently mishandling it; implement the real
challenge-response flow only if this pool's config changes to actually
need one.

New tests: `services/gateway/test/services/cognito-auth-client.test.ts`
(the SDK wrapper — token mapping, legacy-id/sub fallback, challenge and
error handling, client memoization) and
`services/gateway/test/routes/auth-cognito.test.ts` (the route branching —
Cognito-configured vs. Supabase-fallback, for both endpoints, plus
`/health`'s new fields).

## OAuth (Google/Apple) — a real, previously-undocumented gap (VTID-03879)

**This module has zero federation setup for any OAuth provider.**
`cognito.tf` builds a User Pool with password auth + the User Migration
Lambda only. Checked `exafyltd/vitana-v1`'s actual call sites (not assumed
from the plan doc's prose) before writing this: `src/components/
AuthGuard.tsx` and `src/pages/dev/DevLogin.tsx` call
`supabase.auth.signInWithOAuth({ provider: 'apple' })` and `{ provider:
'google' }` respectively, and `src/hooks/useSupabaseOAuthSignIn.ts` is a
shared WebView-aware wrapper around the same call — both are real, live
sign-in paths on production portals, not dead code.

**Why this doesn't fall out of the existing Lambda-migration design for
free.** The User Migration Lambda triggers on `USER_PASSWORD_AUTH` — it has
no bearing on an OAuth flow at all, and `allow_admin_create_user_only =
true` (deliberately set so a genuinely-new signup can't race a
not-yet-migrated legacy account) would also block a first-time Google/Apple
sign-in from silently creating a new Cognito user the way Supabase's GoTrue
does today. Supporting this in Cognito needs **Cognito Identity Provider
federation** — a materially separate piece of AWS configuration per
provider:

- **Google**: register Cognito's own OAuth client with Google (new client
  ID/secret, NOT Supabase's existing one — Google ties a redirect URI
  allowlist to the client), then configure it as a Cognito IdP
  (`aws_cognito_identity_provider`, `provider_type = "Google"`).
- **Apple ("Sign in with Apple")**: needs an Apple Developer Team ID, a
  Services ID, a Key ID, and a private key registered with Apple
  specifically for Cognito's redirect URI — again, not reusable from
  whatever Supabase already has configured, since Apple also ties the key
  to a specific redirect/return URL set.
- Either way, the frontend's OAuth call site changes from
  `supabase.auth.signInWithOAuth()` to either Cognito's Hosted UI redirect
  flow or a custom OIDC/OAuth dance via `amazon-cognito-identity-js`/AWS
  Amplify — a different client-side mechanism than the password flow's
  `InitiateAuth`, so this isn't just "add another branch to
  `cognito-auth-client.ts`."

**What this means for sequencing:** Phase 4 of the wider cutover plan
(frontend call-site rewrite) cannot treat "add Cognito support" as one
uniform task — the password-flow call sites (`MaxinaPortal.tsx`'s
sign-in/sign-up) can move as soon as the User Pool exists, but the three
OAuth call sites above are blocked on a **second, separate infra decision
and setup** (new Google OAuth client, new Apple Services ID/key) that
nobody has scoped or requested credentials for yet. This is exactly the
kind of gap this repo's own governance rules ask to be surfaced rather than
quietly worked around (`NEVER rule 6: never assume unverified context`) —
flagging it now, before anyone assumes the existing Terraform module is a
complete auth-provider replacement.

**Not yet decided, needs a human product/eng call:** whether Apple/Google
sign-in stay as Cognito-federated IdPs (more AWS-native, but two new
external-provider registrations with their own approval/review lag,
Apple's in particular), or whether OAuth sign-in is kept on a thin bridge
(a small service that completes the OAuth handshake and then calls the
User Migration Lambda's same verification path) to avoid re-registering
with Google/Apple at all. No code changes made here — this is a scoping
gap, not a bug with a clear fix, and doesn't block the password-only flow
from proceeding.

## What this does NOT cover — still needed before any real cutover

This directory is the identity **provider**, the gateway can verify its
tokens, and `/login`/`/refresh` can proxy to it. It does not yet touch:

- **Aurora RLS compatibility — partially done (VTID-03830).** 638 policies
  key on `auth.uid()`/`auth.jwt()`, which are Supabase-specific SQL
  functions reading a session GUC (`request.jwt.claims`) that GoTrue's
  PostgREST layer sets per-request — see
  `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` B4 for the fuller framing.
  `withAuroraRlsContext()` (`services/gateway/src/services/aurora-client.ts`,
  VTID-03591) already reproduces that GUC for the one wired-up route
  (`GET /api/v1/admin/aurora-rls-health`), sourced from
  `verifyAndExtractIdentity()`'s claims. **What VTID-03830 fixed:** that
  function was forwarding the raw JWT payload verbatim — for a Cognito ID
  token, `payload.sub` is Cognito's own random UUID, not the legacy
  Supabase user id `extractCognitoIdentity()` resolves into
  `identity.user_id` via `custom:legacy_user_id`. `auth.uid()` reads `sub`
  straight out of the GUC, so this would have silently mismatched every
  `auth.uid() = user_id`-shaped policy for a Cognito-authenticated user —
  the token verifies fine, so the failure is a wrong-owner row match
  inside Postgres, never an auth error. Fixed via a `claimsForRlsContext()`
  normalization step (`middleware/auth-supabase-jwt.ts`) that overwrites
  `sub` with `identity.user_id` before the claims are ever attached to a
  request — a no-op for the existing Supabase HS256/ES256 paths. **What
  is still open:** `withAuroraRlsContext()` remains wired into exactly one
  diagnostic route; extending it to real, request-serving Aurora call
  sites is unstarted, and `exafy_admin` still has no Cognito-side source
  of truth (hardcoded `false` in `extractCognitoIdentity()` — see that
  function's own KNOWN GAP comment).
- **Frontend call sites — re-scoped after actually reading the code (VTID-03884),
  not just grepping the sign-in screens.** `grep -rl "supabase\.auth\."
  src/` in `exafyltd/vitana-v1` returns **116 files, 207 call sites** — far
  more than the 4 sign-in screens the plan doc's earlier prose implied. The
  good news: this is NOT 207 independent rewrites. Nearly all of it is
  centralized in one place, `src/context/AuthProvider.tsx` — a single
  `useEffect` that owns `onAuthStateChange`, the initial `getSession()`,
  OAuth-callback recovery (PKCE code exchange, hash-token `setSession`, a
  `refreshSession` fallback), a 30-second active-session health poller with
  its own transient-vs-definitive-failure classifier, `realtime.setAuth()`
  wiring, and `signOut()`. The other ~200 call sites overwhelmingly read
  `useAuth()` (the context this provider exposes), not `supabase.auth.*`
  directly — so the real rewrite surface is closer to "one intricate
  provider + ~7 direct sign-in/sign-up/OAuth call sites" than "207 call
  sites," which is a materially smaller and more tractable scope than the
  raw grep count suggests.

  **The bad news: that one file is exactly the kind of code this repo has
  already been burned by rewriting blind.** `AuthProvider.tsx` carries
  explicit VTID comments for THREE separate real production incidents this
  exact logic was built to survive: VTID-03652 (a hung `getSession()` on a
  transient backend blip turned into a permanent stuck spinner — fixed with
  a 10s unblock timeout), an unlabeled active-session health monitor whose
  own comment explains it exists because the Appilix WebView/backgrounded
  tabs can suspend `supabase-js`'s auto-refresh timer while the cached
  session still LOOKS valid (fixed with a 30s poll + foreground-resume
  check + a `isDefinitiveAuthFailure()` classifier that only signs out on a
  real dead-refresh-token response, never a transient network blip — the
  comment says the OLD code signed out on any failure and that is "why the
  app appeared to close itself after inactivity"), and VTID-03481 (releasing
  a device's push claim on sign-out, awaited but never allowed to block or
  fail sign-out). It also does `supabase.realtime.setAuth()` explicitly on
  every auth event because this app drives auth through manual
  `setSession`/`exchangeCodeForSession`/`refreshSession` rather than
  supabase-js's own automatic flow, and a missing/stale Realtime auth token
  means RLS silently drops every `postgres_changes` event without an error
  anywhere — the messenger just goes quiet. **None of Cognito's session
  primitives (`InitiateAuth`/`RefreshToken`, no built-in
  onAuthStateChange-equivalent, no automatic realtime-auth-sync since
  Cognito isn't Supabase Realtime's auth source at all) map onto this
  behavior for free** — a correct replacement has to reproduce each of
  these hard-won properties deliberately, not just swap which SDK issues
  the token.

  **Deliberately not attempted blind in this pass.** This session has no
  way to exercise any of it against a real Cognito pool (the IAM boundary
  above blocks pool creation entirely), and per this repo's own established
  pattern for exactly this class of risk (rewriting intricate,
  incident-hardened session/reconnect logic without being able to observe
  the result — see `vitana-platform`'s VTID-03674→03706 ORB-voice chain,
  8+ rounds of regressions from "obvious" fixes applied without
  measurement), attempting `AuthProvider.tsx`'s internals now would be
  guessing at a design nobody can verify. What's genuinely safe to build
  ahead of a live pool: a `cognito-auth-client.ts` for the frontend
  mirroring the gateway's own (`services/gateway/src/services/
  cognito-auth-client.ts`, VTID-03827) — but even that is lower-value than
  it looks, because the gateway's `/login`/`/refresh` proxy already exists
  and is designed so **the frontend's request/response shape doesn't need
  to change at all** (its own header comment says so explicitly) — meaning
  the actual frontend work is less "add a Cognito SDK" and more "point the
  sign-in call sites at the gateway's existing `/auth/login` proxy instead
  of `supabase.auth.signInWithPassword()` directly," then rebuild
  `AuthProvider.tsx`'s session-lifecycle logic (storage, refresh polling,
  realtime re-auth) around whatever that proxy returns — a real design
  task, not a mechanical swap, and one that needs a live pool to verify
  against before it can be trusted with any of the three incidents above.

  Password-flow sign-in/sign-up (`MaxinaPortal.tsx`) can start once a pool
  exists; the OAuth call sites (see the section above) need the federation
  decision first; either way, `AuthProvider.tsx`'s rewrite should be
  planned and reviewed as its own deliberate piece of work, not folded into
  a larger frontend PR as a side effect.
- **Realtime.** 79 Supabase Realtime subscriptions authenticate using the
  same Supabase session; moving auth off Supabase without also addressing
  Realtime's own auth check breaks those subscriptions independently of
  anything in this directory.

None of the above is scaffolded yet. This directory is the first
dependency all of it sits on top of.
