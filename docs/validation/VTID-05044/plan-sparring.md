# Track S slice S4: invitations, edge-function identity, caller-supplied identity, billing flags

- **Change class:** expedited. Track S hotfix slices use the gate's own expedited class (MULTI-TENANT-PLAN §3): at least 2 sparring passes and an immediate owner yes. Break-glass is never used. If the owner does not treat S4 as P1, it falls back to standard (3 rounds).
- **Repos / base:** vitana-platform origin/main `c2c1adc3`; vitana-v1 origin/main `7d869025`.
- **Scope (platform):** `services/gateway/src/routes/tenant-admin/invitations.ts`, `services/tenant-invitations/tenant-invitations-repository.ts`, `routes/billing-repository.ts`, `routes/billing.ts`, `routes/autopilot-prompts.ts`, `controllers/governance-controller.ts`, `routes/governance.ts`, `routes/governance-controls.ts`, `services/orb-tools/admin-governance-tools.ts`, `routes/specs.ts`, `services/gemini-operator.ts` (one fetch header only), `routes/reminders.ts`, `routes/automations.ts`, `.github/workflows/OPS-TOGGLE-FLOW-V3-STAGING.yml`, tests under `services/gateway/test/`, `docs/validation/<VTID>/`.
- **Scope (vitana-v1):** `supabase/functions/{linkedin-import,social-media-import,queue-campaign-recipients,send-welcome-discount,fetch-user-context}/index.ts`, new `supabase/functions/_shared/caller-auth.ts`, new `src/lib/edge-functions-caller-identity.s4.test.ts`.

<!-- plan:begin -->
## 1. Problems (verified on origin/main)
**S-G invitations**
- G1 `invitations.ts:151-217` accept: any signed-in user holding the token gets the invite. Nothing compares `invitation.email` with the caller's email. The handler adds a `user_tenants` row (`:184-192`) and grants every role in `invitation.roles` (`:195-202`). It marks the invite accepted afterwards (`:205`), and that update is not conditional (`repository:70-72`), so two parallel accepts can both succeed.
- G2 `invitations.ts:39`: `roles` comes from the request body and is never validated. A tenant admin (`require-tenant-admin.ts` Step 5) can invite someone as `developer`/`infra`. `engineeringContextAllowed()` (`gemini-operator.ts:4251-4255`) lets those roles see engineering context, and `ROLE_REGISTRY.developer|infra` (`orb/profile/role-registry.ts:79-96`) gives them the developer tool packs. Unknown strings are also stored. The ORB tool `admin_create_invitation` (`admin-tenants-signups-tools.ts:222-247`) passes `args.roles` through this same route.
- The rule already exists for direct grants: `constants/vitana-roles.ts` `SUPER_ADMIN_ONLY_ROLES=['developer','infra']`, enforced in `role-admin.ts:136-140`. Decision 4b says `backoffice` is tenant-admin-grantable. The invite path never applied it.

**S-H edge functions (vitana-v1). Service-role client plus a user id the caller chooses**
- H1 `linkedin-import/index.ts:15,25-26,98,110`: takes `userId` from the body and writes `profiles` with the service role. `verify_jwt=true` (`config.toml`), but the public anon key passes that check. Nothing in the frontend calls this function (AURORA-B7 inventory, plus a grep).
- H2 `social-media-import/index.ts:32,42-44,115`: same problem. Caller: `SocialMediaImportDialog.tsx:125` (`functions.invoke`, which sends the user JWT).
- H3 `queue-campaign-recipients/index.ts:15-20`: the service role builds recipients from `campaignId`/`audienceData`/`messageContent` supplied by the caller and inserts them into `campaign_recipients` + `message_queue`. `process-campaign-queue` (`verify_jwt=false`) then sends them. Result: any anon-key holder can mass-message members by email, SMS or WhatsApp. The only caller is `trigger-scheduled-campaigns/index.ts:58` (`functions.invoke` with a service-role client). Nothing in `src/` calls it.
- H4 `send-welcome-discount/index.ts:27-41`: `verify_jwt=false`. The body supplies `user_id`, `code`, `discount_percent` and `expires_at`. The function looks up the user's email with `auth.admin.getUserById` and sends a Maxina-branded HTML email with `code` interpolated unescaped. That is open phishing to any member. The only caller is the pg_net trigger `notify_welcome_discount` (migration `20260210141933_…sql:96-120`), with the bearer taken from vault `service_role_key`.
- H5 (found by the all-functions scan) `fetch-user-context/index.ts:656-681`: when the body has `userId`, the function uses it directly ("from service role call") and builds the full user context with the service role (`:715`). `verify_jwt=true`, but the anon key passes. The only caller is `generate-enhanced-recommendations/index.ts:38`, which sends no body and so takes the `getUser` path.
- Scan result: every other service-role function either checks the caller with `getUser`/`getClaims` and compares it to the body id (`get-proactive-context:41-56`, `generate-proactive-greeting:40-55`, `remove_super_admin` exafy check), uses a shared secret (`send-test-user-confirmation:60`), or takes no user id at all.

**S-I caller-supplied identity/tenant (gateway)**
- I1 `autopilot-prompts.ts:70,88,98`: the `x-tenant-id` header is used whenever `me_context` returns no tenant. The fallback `'11111111-…'` is not a real tenant and violates the FK.
- I2 `governance-controller.ts:31-34`: tenant comes from `x-tenant-id` or `?tenantId`, else `'SYSTEM'`. The router is mounted with no auth (`index.ts:747`, `routes/governance.ts`).
- I3 `governance-controls.ts:37-41,49-53,138-145`: actor and role come from `x-user-id`/`x-user-role`, and the role defaults to `'operator'`, which is in `ALLOWED_ROLES`. So **an unauthenticated POST with no headers toggles a system control.** That includes the autonomy kill switches (CLAUDE.md §5). Callers: Command Hub `app.js:20857,20898` (already sends `Authorization` via `buildContextHeaders`); ORB `admin_set_control_key` (`admin-governance-tools.ts:21-23,187`, sends spoofed `x-user-role:'admin'`, and `adminGate` also admits tenant `admin`); `OPS-TOGGLE-FLOW-V3-STAGING.yml:44-57` (header spoof).
- I4 `specs.ts:1164-1167`: `POST /:vtid/approve` has no auth and takes the actor from `x-user-id`/`x-user-role`. It writes `spec_status=approved` and `spec_approved_by` (`:1244-1268`), which bypasses governance rule 5. Callers: Command Hub `app.js:10216` (has `Authorization`); operator tool `dev_approve_spec` (`gemini-operator.ts:5537-5545`, sends `Bearer SUPABASE_SERVICE_ROLE`, not the gateway token). Command Hub `app.js:46148` posts to `/api/v1/specs/approve`, a route that does not exist. That is a pre-existing bug and out of scope.
- I5 `reminders.ts:55-64`: when `identity.tenant_id` is null (Cognito tokens, `auth-supabase-jwt.ts:256`), the tenant comes from `X-Tenant-ID` / `X-Vitana-Tenant` / `DEFAULT_TENANT_ID`. The user id is already verified (`:36-53`).
- I6 `automations.ts:67-69`: `getTenantId` falls back to `req.body.tenant_id` and `DEFAULT_TENANT_ID`. That is legitimate on the `requireInternalOrAdmin` routes (`:114-185,312`). It is not legitimate on the member routes `/wallet/*`, `/sharing/*`, `/referrals` (`:190-305`).
- Verified, no change needed: `admin-memory-broker.ts:33-36` is `requireAuth`+`requireExafyAdmin`, so `?tenant_id` is legitimate. `conversation.ts:1056` uses `bindConversationQueryIdentity` (`conversation-identity.ts:41-99`, which does a membership check).

**S-K billing**
- K1 `billing-repository.ts:281-283` `fetchTenantSettingsFeatureFlags` calls `.maybeSingle()` on every `tenant_settings` row. With 2 rows this errors, the destructure gets `data:null`, and `billing.ts:1308-1317` silently reports `marketing_budget_remaining_cents: null`. `fn_redeem_code` keeps this budget **per tenant** (migration `20260526060000_…:240-266`). `/admin/metrics` is exafy_admin-only (`billing.ts:1242-1244`), and every other metric in it is cross-tenant.

## 2. Fixes
- **G2 create:** validate `roles` with `isVitanaRole` (400 `INVALID_ROLE` plus `valid_roles`). If any role is in `SUPER_ADMIN_ONLY_ROLES` and `!req.identity.exafy_admin`, return 403 `ROLE_NOT_GRANTABLE`. Remove duplicate roles. Decision: tenant admins may grant community, patient, professional, staff, backoffice and admin, exactly as `role-admin.ts` does today. Only exafy_admin may grant developer/infra. `commerce` is not in `VITANA_ROLES`, so it is rejected. The frontend `Invitations.tsx:43` offers only roles that pass.
- **G1 accept:** load the auth user with `supabase.auth.admin.getUserById(userId)`, following the `community-invites.ts:64-67` pattern. Require `email_confirmed_at` and `lower(trim(user.email)) === invitation.email`. The stored email is already lowercased at `:61`. Otherwise return 403 `EMAIL_MISMATCH` or `EMAIL_UNVERIFIED`, and the invite stays pending. Re-check the roles at accept time: if the invite carries a super-admin-only or unknown role and the inviter (`getUserById(invited_by).app_metadata.exafy_admin`) is not exafy_admin, return 409 `INVITATION_ROLES_INVALID`. This defuses invites already in the table. Claim before granting: the new repo fn `claimInvitation(id, userId)` runs `update … where id and accepted_at is null and revoked_at is null` and returns the row; no row means 409 `ALREADY_USED`. The existing `markInvitationAccepted` call is removed.
- **H1/H2:** new `_shared/caller-auth.ts` with:
  - `requireUser(req)`: `createClient(URL, ANON, {global:{headers:{Authorization}}}).auth.getUser()` → user, or 401.
  - `isServiceRoleCaller(req)`: true if the bearer equals `SUPABASE_SERVICE_ROLE_KEY` exactly, or `getClaims(bearer).claims.role === 'service_role'`. Uses supabase-js ≥2.57.2 per the VTID-05008 guard.

  Both functions use `requireUser`. A body `userId` that differs from the JWT user returns 403. The service-role client stays for the writes, keyed on the verified id. `SocialMediaImportDialog` keeps working because it already sends the user's JWT.
- **H3:** `queue-campaign-recipients` accepts service-role callers (`trigger-scheduled-campaigns`) or an exafy_admin user (`requireUser` and `app_metadata.exafy_admin===true`, following the `approve-reseller-payout:24-49` pattern). Everyone else gets 401/403. Defence in depth: reload the campaign by `campaignId`, refuse with 409 unless `status` is `scheduled` or `active`, and take `messageContent` from `campaign.distribution_config` when the caller is not exafy_admin.
- **H4:** `send-welcome-discount` returns 401 unless `isServiceRoleCaller`. It then reloads `user_discount_codes` by `discount_code_id` and uses that row's `user_id`, `code`, `discount_percent` and `expires_at`, ignoring those body fields. It HTML-escapes the interpolated values. The pg_net trigger and its body are unchanged.
- **H5:** `fetch-user-context` honours body `userId` only when `isServiceRoleCaller`. Otherwise it always uses `getUser()`, and a body id that differs from the JWT user returns 403.
- **I1:** delete the header and the `'1111…'` fallback. Tenant = `me_context.tenant_id`, then `identity.tenant_id`, then the primary `user_tenants` row (`fetchPrimaryTenantForUser`, same as `requireTenant` at `auth-supabase-jwt.ts:509-528`). If none is found, return 400 `TENANT_REQUIRED`.
- **I2:** `routes/governance.ts` adds `optionalAuth`. `getTenantId` honours `x-tenant-id`/`?tenantId` only when `identity.exafy_admin`, or when the bearer equals `GATEWAY_SERVICE_TOKEN` (reuse `matchesServiceToken`, exported). Otherwise it returns `'SYSTEM'`. Reads stay open, because the Command Hub calls `app.js:13023,19845,20127,20541` without headers.
- **I3:** `POST /governance/controls/:key` becomes `requireServiceOrAdmin` (`middleware/require-service-or-admin.ts:69`). The actor comes from `__control_plane_actor`, `getUserInfo` is deleted, and the headers are ignored. GET routes are unchanged. The ORB tool `adminHeaders` is replaced by `authHeaders(id)`, plus `NO_ADMIN_SESSION` when there is no JWT. A tenant admin now gets 403, which is intended. The OPS-TOGGLE workflow sends `Authorization: Bearer ${{ secrets.GATEWAY_SERVICE_TOKEN }}`; that secret is already used in `AWS-STAGE-DEPLOY-GATEWAY.yml`.
- **I4:** `POST /specs/:vtid/approve` becomes `requireServiceOrAdmin`. Actor = `admin:<user_id>`, or `service:<body.approved_by|internal>` for the service token. The headers are ignored, and `approved_role` becomes `exafy_admin` or `service`. `gemini-operator.ts:5539-5543` sends `gatewayServiceAuthHeader()` (VTID-05019) instead of the Supabase service key.
- **I5:** `getTenantId` uses `identity.tenant_id`, then the primary `user_tenants` row via `requireTenant` on the non-open paths. Headers and `DEFAULT_TENANT_ID` are removed. `/stream` does not use the tenant.
- **I6:** split the helper. `getAdminTargetTenantId` (body `tenant_id` or `DEFAULT_TENANT_ID`) is used only on `requireInternalOrAdmin` routes. `getMemberTenantId` returns only `identity.tenant_id` on the member routes.
- **K1:** `fetchTenantSettingsFeatureFlags` selects `tenant_id, feature_flags` across all rows, with no `maybeSingle`. Decision: the metric becomes an aggregate. `marketing_budget_remaining_cents` = sum of the numeric values (null if none is set), which keeps the Command Hub `app.js:14021` contract. An additive field `marketing_budget_remaining_by_tenant: {tenant_id: cents|null}` is added. A read error is logged, not swallowed into null.

## 3. Tests (in the same PR, red before the fix)
- `test/routes/tenant-admin/invitations.test.ts` (supertest, mocked repo and `auth.admin`):
  - tenant admin + `developer` → 403
  - exafy + `developer` → 201
  - `bogus` → 400
  - `backoffice` and `admin` by a tenant admin → 201
  - accept: email mismatch → 403; case-only difference → 200; unconfirmed → 403
  - invite with legacy `infra` from a non-exafy inviter → 409
  - double accept → second 409; nothing is granted before the claim
- `test/routes/billing-repository.test.ts` replaces "reads a single row". `billing-admin-metrics.test.ts` covers 2 rows → sum and per-tenant map, and 0 rows → null.
- `test/routes/autopilot-prompts.test.ts`: rewrite the header tests to assert the header is ignored; no tenant → 400.
- New `test/s4-caller-identity.test.ts`:
  - controls POST with no auth or with spoofed `x-user-role` → 401; tenant-admin JWT → 403; exafy or service token → 200 with actor recorded
  - specs approve: same matrix
  - governance `x-tenant-id` ignored for anonymous callers
  - reminders/automations header and body tenant ignored for members
  - ORB `admin_set_control_key` sends `Authorization` and never `x-user-role`
- Run `npm run test:operator` (42e: dev_approve_spec path), `npm run test:roles` (42h: invite roles), and the full gateway Jest, `tsc` and lint.
- vitana-v1 `src/lib/edge-functions-caller-identity.s4.test.ts` (Vitest source guard, the pattern of `appointment-and-appilix-functions.vtid-04961.test.ts`, `edge-functions-getclaims.vtid-05008.test.ts`):
  - the 5 functions import `_shared/caller-auth`
  - none reads `userId`/`user_id` from the body without the guard
  - `send-welcome-discount` reads `user_discount_codes` and calls `isServiceRoleCaller`
  - a tree-wide scan fails on any new `SERVICE_ROLE` function that reads a body user id and calls neither `getUser`, `getClaims` nor `caller-auth`
  - `caller-auth.ts` uses supabase-js ≥2.57.2
- Deno unit tests for `caller-auth.ts` only if `deno` is available in CI. It is not today, so this is not required.

## 4. Staging tests (rule 48: unauthenticated, read-only, `rejected_probe` only)
- **PR-A:**
  - `POST /api/v1/admin/invitations/accept/s4-probe-invalid` rejected_probe, 401
  - `POST /api/v1/admin/tenants/00000000-0000-4000-8000-000000000000/invitations` rejected_probe, 401
  - `GET /api/v1/billing/admin/metrics`, 401
  - `existing`: jest for the invitations and billing tests
- **PR-B:**
  - `POST /api/v1/governance/controls/__s4_probe_nonexistent__` rejected_probe, 401, with no body. The old code would answer 400 from zod with no write.
  - `POST /api/v1/specs/VTID-00000/approve` rejected_probe, 401. The old code would answer 404 with no write.
  - `GET /api/v1/governance/controls`, 200 `{ok:true}` (Command Hub read kept)
  - `GET /api/v1/governance/rules`, 200
  - `GET /api/v1/autopilot/prefs`, 401
  - `existing`: `s4-caller-identity` and operator suite
- **PR-C:** no staging exists for edge functions (single Supabase project), so STAGING-VERIFY does not apply. The evidence is CI Vitest plus the read-only post-deploy checks in §5.

## 5. PR split, VTIDs, deploy
- **PR-A** (platform; S-G + S-K; 1 VTID): tenant-admin surface plus billing metric. Merge → staging → STAGING-VERIFY → Gate 2 → `AWS-PROD-DEPLOY-GATEWAY.yml` with `expected_commit=<merge sha>`, after diffing production build-info..sha (rule 26).
- **PR-B** (platform; S-I; 1 VTID): identity/header hardening, ORB tool, operator header, OPS-TOGGLE workflow. Same pipeline, released after PR-A or together in one Gate 2.
- **PR-C** (vitana-v1; S-H; 1 VTID): edge functions plus guard test. On merge the push deploy is frozen (cutover gate), so it does not deploy. At Gate 2, with owner yes on CI evidence, dispatch `supabase-functions-deploy.yml` on `main` with `functions="linkedin-import social-media-import queue-campaign-recipients send-welcome-discount fetch-user-context"`. First run `git log <last deploy>..main -- supabase/functions/{those}` plus `_shared/caller-auth.ts` and confirm only PR-C commits are in range. The deploy honours `config.toml` `verify_jwt`, which is unchanged.
- **Post-deploy (read-only only):** `list_edge_functions` shows the new versions. Read-only SQL on `net._http_response` for the welcome-discount calls after the deploy must show 200, not 401. Function logs must show no new 401 spikes from `SocialMediaImportDialog`. No probe calls against production.

## 6. Rollback
- Platform: `git revert` the PR → staging → STAGING-VERIFY → production dispatch, or redeploy the previous image through the workflow's rollback (VTID-04647). There are no migrations and no data writes.
- Edge: revert PR-C, then dispatch the same 5 functions. If the welcome emails return 401 (the vault key does not match either service-role check), revert only `send-welcome-discount`. No email is lost silently, because pg_net responses are kept and the email can be re-sent from `user_discount_codes`.

## 7. Risks
- R1 vault `service_role_key` may be a different key format from the edge env key. `isServiceRoleCaller` therefore accepts either an exact match or a verified `service_role` claim, and the R1 check in §5 detects a mismatch within one signup.
- R2 accept now needs a confirmed email that matches. Invitees who sign up with a different address must be re-invited. That is intended, and the error message says so.
- R3 tenant admins lose voice/ORB control toggling and spec approval. That is intended (platform-level controls). The Command Hub (exafy_admin) is unaffected.
- R4 `OPS-TOGGLE-FLOW-V3-STAGING.yml` breaks if `GATEWAY_SERVICE_TOKEN` is unset on staging. It is set: the stage deploy workflow uses it.
- R5 Cognito sessions without `tenant_id` now resolve through the DB. That adds one lookup per reminders/autopilot call, the same cost `requireTenant` already pays.
- R6 S-E (separate slice) changes how `active_tenant_id` is trusted. S4 relies only on `identity.tenant_id`, so the two compose.

## 8. Out of scope (flagged; tracked under S-J route-inventory slice)
- Unauthenticated writes on `routes/governance.ts`: `POST /evaluate`, `/proposals`, `PATCH /proposals/:id/status`.
- Unauthenticated `specs.ts` writes: `/:vtid/generate` `:536`, `PATCH /:vtid` `:744`, `/validate` `:853`, `/quality-check` `:1023`. Internal callers (`email-intake.ts:115-126`, `gemini-operator.ts:5393-5508`, `operator-planner.ts:113`) need the service header first.
- `process-campaign-queue` and `trigger-scheduled-campaigns` (`verify_jwt=false`). They drain only work that is already queued. After H3 they cannot inject content.
- Command Hub `app.js:46148` posts to the dead `/api/v1/specs/approve`.
- No frontend route exists for the `/admin/invitations/accept/:token` link (`Invitations.tsx:82`).
- `exafy_admin` is hard-coded false for Cognito tokens (`auth-supabase-jwt.ts:243-257`).

### Round-1 amendments (binding, supersede earlier text where they differ)
- **ORB control tool auth (F1):** `admin_set_control_key` (admin-governance-tools.ts) keeps its existing `adminGate(id)` check (the ORB caller must be an admin) and then calls the gateway with `gatewayServiceAuthHeader()` imported from `middleware/require-service-or-admin.ts:61` (existing export), plus an informational `x-orb-caller-user-id: <id.user_id>` header that is recorded only as the actor label (`orb:<user_id>` via service auth) and never used for authorization. The governance-controls handler derives the actor from `req.identity` (service → `service:internal`) and appends the ORB caller label when present; a test pins both labels. The spoofed `x-user-id`/`x-user-role` headers are removed from every caller.
- **queue-campaign-recipients (F2):** service-role only — the exafy_admin path is dropped (the only caller is `trigger-scheduled-campaigns`). In addition the function reloads the campaign by `campaignId` and scopes recipient queries to `campaign.tenant_id` (defence in depth).
- **automations member routes (F3):** the member wallet/sharing/referral routes (automations.ts ~190-304) get explicit `requireAuth` in this PR; behaviour is unchanged (they already returned 401 because `identity` was never populated), but it is now by design; a test pins 401 for anonymous calls.
- **Import source (F4):** `gatewayServiceAuthHeader()` is imported from `middleware/require-service-or-admin.ts`; no dependency on a future VTID.
- **Probe justification (F5):** the old code answered 400 (body validation) because the default `operator` role passed the role check; after the fix the probe gets 401 from the auth middleware before body parsing.
- **linkedin-import (F6):** patched now (caller-auth) as defence in depth and flagged for removal in the S-J inventory (no frontend caller).
<!-- plan:end -->

## Planner responses
(none yet: round 1 pending)

## Planner responses — round 1
- F1 ACCEPTED — ORB tool: adminGate + gatewayServiceAuthHeader() + informational caller label; actor recorded as service:internal / orb:<user_id>; test pins labels. Q1 answered.
- F2 ACCEPTED — exafy_admin path dropped (service-role only) and recipient queries scoped to the campaign's tenant. Q2 answered.
- F3 ACCEPTED — requireAuth added to member automations routes in this PR, with a 401 test.
- F4 ACCEPTED — existing export in require-service-or-admin.ts:61. Q3 answered.
- F5 ACCEPTED — justification corrected.
- F6 ACCEPTED — patched now, flagged for removal in S-J.

## Sparring verdict
Round 1: 2 major (F1, F2) + 4 minor → all accepted. Round 2: all closed, no new findings. **Verdict: CONVERGED** (2 rounds).
Final plan-body hash: `19347922045ecf05300f7742b67c2ec5510c396b3895a1887e0d9bb6d22f723e`

## Scope of this VTID
VTID-05044 implements **PR-A only** (S-G invitations + S-K billing metric, plan §5). PR-B (S-I) and PR-C (S-H, vitana-v1) carry their own VTIDs.

## Approval
Owner approval (Gate 1): "Yes approved" — 2026-10-10, Claude Code session; plan hash 19347922045ecf05300f7742b67c2ec5510c396b3895a1887e0d9bb6d22f723e; sparring record a9adf7ec-d504-47c3-88bb-c61d08132f5c.
