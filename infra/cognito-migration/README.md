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

## What this does NOT cover — still needed before any real cutover

This directory is the identity **provider**, and the gateway can now verify
its tokens. It does not yet touch:

- **The gateway's own `/auth` proxy routes** (`services/gateway/src/routes/
  auth.ts`, lines ~127/346) still proxy straight to GoTrue's
  `/auth/v1/token` endpoints. These need Cognito equivalents
  (`InitiateAuth`/`RespondToAuthChallenge` via the AWS SDK).
- **Aurora RLS compatibility.** 638 policies key on `auth.uid()`/
  `auth.jwt()`, which are Supabase-specific SQL functions reading a
  session GUC that GoTrue's PostgREST layer sets per-request. A
  Cognito-issued JWT's claims need to end up in that same GUC (or an
  equivalent compatible function) for those policies to keep working
  unmodified — see `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` B4 for the
  fuller framing, and this repo's existing `withAuroraRlsContext()`
  mechanism (built earlier in this migration for the non-auth Aurora
  seams) as the closest existing pattern to extend.
- **Frontend call sites.** `exafyltd/vitana-v1`'s `MaxinaPortal.tsx`,
  `ExafyAdminPortal.tsx`, `CommercePortalLogin.tsx`, `DevLogin.tsx` all call
  `supabase.auth.signInWithPassword()`/`signUp()`/`signInWithOAuth()`
  directly against GoTrue. Each needs a Cognito-based replacement (likely
  via `amazon-cognito-identity-js` or AWS Amplify Auth).
- **Realtime.** 79 Supabase Realtime subscriptions authenticate using the
  same Supabase session; moving auth off Supabase without also addressing
  Realtime's own auth check breaks those subscriptions independently of
  anything in this directory.

None of the above is scaffolded yet. This directory is the first
dependency all of it sits on top of.
