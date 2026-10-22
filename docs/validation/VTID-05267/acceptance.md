# VTID-05267 — mt-jobs/jobs-automation-actor-tenant acceptance

Lane acceptance: `.kiro/specs/mt-jobs/tasks.md` group `jobs-automation-actor-tenant` (A1–A3; plan copy: `plan.md` here).
Suite: `services/gateway/test/vtid-05267-automation-actor-tenant.test.ts` (29 tests).
Red on base (main 5f76b3ab, suite copied in): 19 failed / 10 passed — `outputs/jest-vtid-05267-base.txt`.
Green on head: 29/29 — `outputs/jest-vtid-05267-head.txt`.
Ships dark: `MT_RESOLUTION_V2` unset ⇒ every site dispatches with `DEFAULT_TENANT_ID`, no tenant lookup.

AC-1 — Flag off ⇒ each of the seven sites dispatches with `DEFAULT_TENANT_ID` exactly as today and never calls `resolvePrimaryTenant`.
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › flag off ⇒ DEFAULT_TENANT_ID, no tenant lookup (today)

AC-2 — Raw-bearer routes (`community.ts` `/groups/:id/join`, `/global-groups/:id/join`; `match-feedback.ts` `/:id/feedback`; `matchmaking.ts` `/:id/state`): flag on ⇒ the token `sub`'s primary tenant, read only after the user-scoped Supabase call succeeded; never Maxina.
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › flag on ⇒ the token sub's primary tenant, never Maxina
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › a failed user-scoped call dispatches nothing

AC-3 — `resolvePrimaryTenant` not `'found'` (`none`, `unavailable`) ⇒ no dispatch, no Maxina tag (the resolver logs `actor_tenant_unresolved`).
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › flag on, primary tenant '%s' ⇒ no dispatch, no Maxina tag

AC-4 — `community.ts` `/global-groups/:id/view` (requireAuth): flag on ⇒ `req.identity.tenant_id`, else the user's primary tenant; unresolvable ⇒ no dispatch.
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › community.ts POST /global-groups/:id/view (requireAuth identity)

AC-5 — `admin-signups.ts` `/log-result`: flag on ⇒ `user.signup.completed` / `.referral` / `.shared_link` tagged with `auth_user_id`'s primary tenant; unresolvable ⇒ no dispatch, response unchanged.
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › admin-signups.ts POST /log-result

AC-6 — `groups-events-tools.ts` join_group (fallback site): an `id.tenant_id`-present dispatch keeps that tenant on both flag states with no lookup; absent ⇒ `DEFAULT_TENANT_ID` (off) / primary tenant (on) / no dispatch when unresolvable, and the join still succeeds.
TEST: services/gateway/test/vtid-05267-automation-actor-tenant.test.ts › groups-events-tools.ts join_group (fallback site)

ROUTE_MOUNT: No new route and no new mount. Only the bodies of existing handlers change (the automation-dispatch block); paths, methods, auth middleware and mounts in `services/gateway/src/index.ts` are untouched.
FINAL_URL: N/A (no new endpoint).
CURL_PROOF: N/A — the changed routes are member writes; staging verification is read-only (rule 48), so `staging-tests.json` checks `GET /alive` only and the dispatch tenant is proven by the Jest suite above.

OASIS_IMPACT: no — no OASIS event is added or changed; only the tenant argument of `dispatchEvent` under the flag.
