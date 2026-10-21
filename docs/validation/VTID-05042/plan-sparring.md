# Track S — slice S3: tenant-scope leaks reachable by tenant admins + self-enrolment

- **Change class:** standard (auth middleware, admin routes, migrations touching auth.users / user_tenants triggers). Not expedited: no P1 open; Track S "expedited" timebox may be applied by the owner.
- **Read at:** vitana-platform `origin/main` a8be332e, vitana-v1 `origin/main` 7d869025; MULTI-TENANT-PLAN v5.1 §3 (S-E, S-F, S-L), §4.2.
- **Scope files (platform):** `services/gateway/src/routes/admin-partner-health.ts`; `routes/tenant-admin/{audit-log,overview,community-admin,content-moderation}.ts` (+ their `-repository.ts`); `middleware/auth-supabase-jwt.ts` + `auth-supabase-jwt-repository.ts`; new `supabase/migrations/<ts>_vtid_<B>_s3_*` (3 files) + rollback twins; tests under `services/gateway/test/**`; `docs/validation/<VTID>/**`.
- **Scope files (vitana-v1):** none required (callers degrade already, see S-E-5/S-F-6); no migration lands in vitana-v1.

<!-- plan:begin -->
## 1. Problems (verified on origin/main)
- **S-L** `admin-partner-health.ts:68-78` — `requirePartnerHealthAccess` maps `user_tenants.active_role='admin'` (any tenant) to `{scope:'admin'}`, which `allVisiblePartnerIds()` treats as unfiltered. `GET /orders` (:129-153), `PATCH /orders/:id` (:155), `GET /inbox` (:205), `GET /candidates/:inboxId` (:223), `POST /inbox/:id/upload-result` (:255), `POST /inbox/manual` (:316), `POST /inbox/:id/confirm-match` (:350, takes `matched_tenant_id` from the body) carry no tenant predicate → an Alkalma admin reads/acts on every tenant's lab orders and health results.
- **S-F1** `tenant-admin/audit-log-repository.ts:37-44` `fetchAuthOasisEvents` — `oasis_events` has no tenant column (`supabase/migrations/20251209000000_add_task_stage.sql:10-35`); `GET /audit/access` (`audit-log.ts:39-47`) returns platform-wide events to any tenant admin.
- **S-F2** `tenant-admin/overview-repository.ts:66-72` `fetchRecentOasisEvents` / `fetchRecentSevereOasisEvents` — unfiltered `oasis_events` (platform ops: deploys, VTIDs, errors) via `overview.ts:166` `/activity` and `:199` `/alerts`. `/summary` and `/at-risk` are already `.eq('tenant_id')` — untouched.
- **S-F3** `tenant-admin/community-admin-repository.ts:21-83` — service-role reads with no tenant predicate: `global_community_events` (+ **DELETE** `:25-26` via `community-admin.ts:77`), `global_community_groups`, `global_community_group_members`, `creator_profiles`, `live_rooms`, `community_memberships`; `/stats` counts all of them.
  - Tenant column today: `live_rooms.tenant_id NOT NULL` (platform `20251231000001_vtid_01090…sql:102`), `community_memberships.tenant_id NOT NULL` (`20251231100000_vtid_01084…sql:83`). **None** on `global_community_*` (vitana-v1 `20250917153624…sql:1` "cross-tenant community features"); `creator_profiles` has no tenant_id in any migration found (implementation re-checks the migration text; if one exists it moves to the "filter" bucket).
- **S-F4** `tenant-admin/content-moderation.ts:29-137` via `services/content-moderation/content-moderation-repository.ts:22-37` — `media_uploads` (keyed by `user_id`, no tenant_id; vitana-v1 `20251010071955…sql`) listed, counted and **approve/reject/flag-mutated** for every tenant.
- **S-E1** vitana-v1 `supabase/migrations/20250909092110_250b18a4…sql` `switch_to_tenant_by_slug` (SECURITY DEFINER): any signed-in user, any slug → inserts `memberships`(community) + `role_preferences`, sets `auth.users.raw_app_meta_data.active_tenant_id`; never writes `user_tenants`. Live join path: `AlkalmaPortal.tsx:81`, `useTenant.tsx:182` (fails soft to a local fallback on RPC error, `:185-192`).
- **S-E2** `auth-supabase-jwt.ts:273` `extractIdentity` trusts `app_metadata.active_tenant_id`; `requireTenant` (:496-546) and `requireAuthWithTenant` (:553-635) only consult `user_tenants` when the claim is absent — no membership check. 154 route usages. (`requireTenantAdmin` is already safe: `getCallerRole` checks `user_tenants` for the target tenant.) Other `active_tenant_id` writer: edge fn `set_active_tenant` is exafy_admin-only (vitana-v1 `supabase/functions/set_active_tenant/index.ts:52-60`).
- **S-E3 side effects:** four `AFTER INSERT … WHEN (NEW.is_primary = true)` triggers on `user_tenants`: `welcome_chat_on_primary_membership` → `fire_welcome_chat_on_membership()` (latest `20260917084341_vtid_03990…sql`), `founding_seat_on_primary_membership` → `claim_founding_seat_on_membership()` (`20261003100000_vtid_04859…sql:221`), `seed_onboarding_autopilot_on_primary_membership` → `seed_onboarding_autopilot_on_membership()` (`20260607000000_BOOTSTRAP…sql:172`), `trg_create_user_live_room` → `create_user_live_room()` (`20260210100000_vtid_01228…sql:232`). `ci_welcome_*` health RPC checks the welcome trigger by name and `tgenabled='O'` (`20260804100000_vtid_03492…sql:44-50`).

## 2. Fixes
**S-L.** Delete the tenant-admin branch (:68-78); access = `exafy_admin` → `{scope:'admin'}`, else partner-org scope, else 403 JSON. Update the header comment (:9-10) and the 403 message. Owner decision recorded in plan §3: the DoctorBox fallback UI is Exafy-operated. `confirm-match` for org scope keeps its existing `canActOnOrder`/partner checks (no change).
**S-F — rule: filter where the row carries `tenant_id`; otherwise platform-scope only (exafy_admin) until WS3 adds tenant_id.** Rejected alternative: filtering via author membership (`created_by`/`user_id ∈ user_tenants(tenant)`) — dual members make one tenant's admin able to read/delete/moderate content that is shown in another tenant (global groups/events are cross-tenant by design), and it invents a tenancy model WS3 will define differently. Platform-only is the smaller, reversible change.
1. Add a tiny route-level guard `requirePlatformScope` (in `middleware/require-tenant-admin.ts`, reusing `requireTenantAdmin`'s identity): non-exafy → `403 {ok:false,error:'PLATFORM_SCOPE_ONLY'}`. Applied after `requireTenantAdmin`.
2. Audit `/access` → platform-only. `/actions` unchanged (already `.eq('tenant_id')`).
3. Overview `/activity`, `/alerts` → platform-only.
4. Community admin: `/live-rooms` and `/memberships` → add `tenantId` param to the repo fns, `.eq('tenant_id', tenantId)` (for exafy too: the URL names the tenant). `/meetups` GET + DELETE, `/groups`, `/creators`, `/stats` → platform-only (stats mixes global counts).
5. Content moderation: all six `/items*` routes → platform-only.
6. vitana-v1 hooks already surface non-2xx as React Query errors (`adminFetch` throws; `useAdminCommunity.ts:36-49`) → tenant admins see the existing error state. No UI change in S3 (hiding the tiles is WS8). Listed under "Decisions taken".
**S-E (DB part — must be applied to production before the gateway part is published).**
1. Migration A `…_s3_membership_side_effect_guard.sql`: `CREATE FUNCTION public.membership_side_effects_suppressed() RETURNS boolean STABLE LANGUAGE sql AS $$ SELECT coalesce(current_setting('vitana.suppress_membership_side_effects', true),'') = 'on' $$;` then, in one transaction, `DROP TRIGGER IF EXISTS … ; CREATE TRIGGER … WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed())` for all four triggers (names, timing, functions unchanged → health RPC stays green). **Why the WHEN clause, not each function body:** re-emitting four large `CREATE OR REPLACE FUNCTION` bodies risks reverting live drift (welcome chat has two versions); the WHEN guard touches no body and is one predicate. The setting is only ever set with `set_config(…, true)` (transaction-local) — never `ALTER DATABASE/ROLE`. Also `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS open_signup boolean NOT NULL DEFAULT false; UPDATE public.tenants SET open_signup = true WHERE slug IN ('maxina','alkalma');` (assert exactly 2 rows).
2. Migration B (data, `supabase/migrations/data-fixups/…_s3_backfill_drifted_memberships.sql`), single transaction, `SET LOCAL lock_timeout='3s'`:
   - `PERFORM set_config('vitana.suppress_membership_side_effects','on', true)`.
   - Snapshot `bak_s3_drift_20261010` = `memberships m` (status active) with no `user_tenants` row for (tenant,user); **assert** every row is in an `open_signup` tenant and count ≤ 30 (verified 15: maxina 11, alkalma 4) else `RAISE` (abort, report).
   - `UPDATE app_users SET welcome_chat_sent = true WHERE user_id IN (snapshot)` (belt-and-braces for any later primary insert).
   - `INSERT INTO user_tenants (tenant_id,user_id,active_role,is_primary) SELECT …, 'community', NOT EXISTS (primary row for user) … ON CONFLICT (tenant_id,user_id) DO NOTHING`.
   - Claim remediation: snapshot `bak_s3_claims_20261010` of `auth.users` whose `raw_app_meta_data->>'active_tenant_id'` has no `user_tenants` row and `exafy_admin` is not true; assert count ≤ 50 else abort; set their `active_tenant_id` to their primary `user_tenants.tenant_id` (or remove the key if none).
   - Post-check (in-txn): `SELECT count(*) …` of the drift set = 0; the GUC is gone after COMMIT.
3. Migration C `…_s3_switch_tenant_open_signup_only.sql`: `CREATE OR REPLACE switch_to_tenant_by_slug(p_tenant_slug text)` (same signature, DEFINER, `search_path=public`): `auth.uid()` NULL → raise; tenant missing → raise; if `user_tenants` row exists OR caller exafy_admin → switch only; elif `tenant.open_signup` → insert `memberships` (if absent, community/active), `role_preferences` (unchanged upsert), `user_tenants (…,'community', is_primary = NOT EXISTS primary) ON CONFLICT (tenant_id,user_id) DO NOTHING`; else `RAISE EXCEPTION 'TENANT_NOT_JOINABLE' USING ERRCODE='42501'`. Then the existing `active_tenant_id` update + `audit_events` row. `REVOKE EXECUTE … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`. A new open-signup join that is the user's first primary DOES fire the four triggers — intended (real new member, VTID-03089 idempotency via `welcome_chat_sent`).
4. Order: A → B → C in one RUN-MIGRATION dispatch after owner approval (Gate 2 of the DB PR; staging shares the prod DB, so these are production writes). Off-peak. Post-apply read-only verification queries recorded in `docs/validation/<VTID-B>/post-apply.sql`: four triggers present + enabled with guard in `pg_get_triggerdef`; `open_signup` = {maxina, alkalma}; drift = 0; claims-without-membership = 0 (exafy excluded); `has_function_privilege('anon','switch_to_tenant_by_slug(text)','execute')` = false.
**S-E (gateway part).** `requireTenant` + `requireAuthWithTenant`: when the tenant came from the JWT claim and caller is not exafy_admin → `repo.fetchMembershipForUserTenant(sb,user,tenant,signal)` (`auth-supabase-jwt-repository.ts`), positive-result cache 60 s (same pattern/TTL as the vitana_id cache). Not a member → `403 {ok:false,error:'TENANT_NOT_MEMBER'}` + structured warn (no OASIS event: a rejection is not a state transition); lookup error/timeout → `503 {ok:false,error:'TENANT_CHECK_UNAVAILABLE'}` (fail closed, loud). Env `TENANT_MEMBERSHIP_CHECK_MODE=enforce|log` (default `enforce`; `log` is the no-code rollback lever). Run concurrently with `resolveVitanaId` (no added serial latency in `requireAuthWithTenant`). `requireAuth`-only routes that read `identity.tenant_id` stay out of scope (§4.2 TenantContext) — residual covered because after C + claim remediation no non-exafy path can mint a non-member claim; stale tokens ≤ 1 h.

## 3. Rollback
- Gateway parts: revert PR (or `TENANT_MEMBERSHIP_CHECK_MODE=log` via task-def deploy).
- `…_rollback_s3_switch_tenant.sql`: restore the 20250909092110 body verbatim + previous grants.
- `…_rollback_s3_guard.sql`: recreate the four triggers with the original `WHEN (NEW.is_primary = true)`, drop the helper; `open_signup` column kept (inert).
- Data: `DELETE FROM user_tenants USING bak_s3_drift…` rows inserted (DELETE fires no insert trigger); restore `active_tenant_id` and `welcome_chat_sent` from the bak tables. Bak tables kept 30 days.

## 4. Tests
- **Jest (gateway, supertest, existing mock style of `test/admin-partner-health.test.ts` / `test/routes/tenant-admin/*.test.ts`):**
  - partner-health: new `tenant-admin-1` token (`tenant_id:'tenant-2'`, `user_tenants.active_role='admin'`, no org) → 403 on all 7 routes; exafy + staff/professional cases unchanged.
  - audit `/access`, overview `/activity` `/alerts`, community `/meetups` GET/DELETE, `/groups`, `/creators`, `/stats`, content `/items*`: tenant admin → 403 `PLATFORM_SCOPE_ONLY` and **no query issued**; exafy → 200. `/live-rooms`, `/memberships`: `.eq('tenant_id', :tenantId)` asserted for tenant admin and exafy. Existing tests that assert tenant-admin 200 on these routes are rewritten (contract change, called out in the PR).
  - `test/middleware/auth-supabase-jwt.test.ts`: claim member → next; claim non-member → 403; exafy non-member → next; no claim → primary fallback unchanged; lookup throws → 503; `log` mode → next + warn; cache hit issues one lookup for two calls.
  - Full gateway jest run (154 `requireTenant*` users: fixtures with a JWT tenant need a membership row in the mock — fix fixtures, never loosen).
- **Migration-text test** `test/vtid-<B>-s3-migrations.test.ts`: all four triggers recreated with the guard; `set_config(…, true)` only (no `ALTER DATABASE|ROLE … SET vitana.`); RPC contains `open_signup`, `ON CONFLICT (tenant_id, user_id) DO NOTHING`, `42501`, `REVOKE … FROM PUBLIC, anon`; backfill has both asserts; rollback files exist and restore the original WHEN.
- **PGlite dry run** `docs/validation/<VTID-B>/pglite-migration-check.mjs` (VTID-04762 pattern): stub `auth.users`/`auth.uid()` (reads `request.jwt.claims`), tenants maxina/alkalma/earthlings, `memberships`, `user_tenants` + unique index, `app_users`, four stub trigger functions writing to `side_effect_log`. Assert: B inserts 15 drift rows with 0 side effects and `welcome_chat_sent`; a primary insert outside the txn logs 4 side effects; RPC: earthlings non-member → 42501, alkalma non-member → member, non-primary when a primary exists, idempotent on repeat, existing member of closed tenant switches fine; rollback restores behaviour.
- **Suites:** `npm run test:roles` (touches ORB-adjacent auth; role suite references `user_tenants`), `npm run test:support`, `npm run test:operator` — all three run on both gateway PRs since `requireTenant*` is shared middleware.

## 5. staging-tests.json sketch (read-only, rule 48)
```json
{"vtid":"VTID-<A>","service":"gateway","tests":[
 {"kind":"probe","name":"partner-health unauth","method":"GET","url":"/api/v1/admin/partner-health/orders","expect":{"status":401,"json":true}},
 {"kind":"probe","name":"partner-health community member","auth":"e2e-test-user","method":"GET","url":"/api/v1/admin/partner-health/orders","expect":{"status":403,"json":true}},
 {"kind":"probe","name":"audit access non-admin","auth":"e2e-test-user","method":"GET","url":"/api/v1/admin/tenants/{maxina}/audit/access","expect":{"status":403,"json":true}},
 {"kind":"existing","name":"S3 admin scope","ref":"npx jest test/admin-partner-health.test.ts test/routes/tenant-admin","cwd":"services/gateway"}]}
```
VTID-B adds: authed test user GET of a `requireAuthWithTenant` read route (e.g. `/api/v1/memory-garden/…` GET) → 200 JSON (own membership passes); migration suites as `existing` with the note that the DB part is applied only at the production step (VTID-04762 wording). No probe can exercise a tenant admin of another tenant without a write — covered by jest.

## 6. PR split / VTIDs (recommend 2 VTIDs, 3 PRs)
- **VTID-A, PR1** — S-L + S-F (gateway only, no migration). Ships independently; Gate 2 = normal staging verify.
- **VTID-B, PR2** — migrations A/B/C + rollbacks + migration-text test + PGlite check. Merges dark (no code reads `open_signup`); applied via RUN-MIGRATION only after owner approval with the post-apply query results.
- **VTID-B, PR3** — gateway membership check. Merge after PR2 is applied; its Gate 2 includes the post-apply evidence (drift = 0, bad claims = 0). Promoting PR3 before PR2's apply would 403 the 15 drifted users.

## 7. Risks
- 403s for real tenant admins on dashboards they use today (Alkalma admins) — intended; message owner-visible in Gate 2.
- Membership lookup on 154 routes: added DB read per cache miss; 60 s cache, concurrent with vitana_id lookup; 503 on DB timeout increases blast radius of a Supabase blip → `log` mode lever.
- Claim remediation writes `auth.users` (production write, owner-approved inside Gate for PR2); threshold abort.
- Live RPC body may differ from the migration text (plan says "live body verified"): PR2 Gate includes a read-only `pg_get_functiondef` capture before apply; rollback restores the captured live body, not the 2025 text, if they differ.
- `tenants` table shared by both repos' migrations — pre-apply read-only check that `memberships.tenant_id` and `user_tenants.tenant_id` reference the same `tenants`.

## 8. Out of scope
TenantContext / access-token hook (§4.2), tenant_id on `global_community_*`/`media_uploads`/`creator_profiles` (WS3), tenant-admin UI tile hiding (WS8), the "join this community" flow, `requireAuth`-only routes reading `identity.tenant_id`, invitations (S-G), x-tenant-id headers (S-I), `memberships` table retirement.

### Round-1 amendments (binding, supersede earlier text where they differ)
- **S-E live reality (planner read-only check 2026-10-10, see S3-live-evidence.md):** the live `switch_to_tenant_by_slug` reads `tenant_record.id`, but live `tenants` has no `id` column (PK `tenant_id`), so every call raises before inserting; `audit_events` has 5,676 `tenant_switch` rows, the last on 2025-12-28. S-E is therefore latent (no self-enrolment possible today), and the join/switch path is broken for everyone, including the `setTenantBySlug('maxina')` call made on every Maxina login (MaxinaPortal.tsx:328-336 is a comment describing it; the caller is the post-login redirect effect → useTenant.tsx:182). Migration C both fixes the bug (uses `tenant_id`) and keeps the `open_signup` guard. Behaviour change after apply: those calls succeed again; for existing members the insert is a no-op (`ON CONFLICT DO NOTHING`, `is_primary` only when none exists), so no primary-membership trigger fires.
- **Cross-repo guard (F1):** Migration C carries a header noting the function originated in vitana-v1 and is now co-owned. A mirror Vitest guard in exafyltd/vitana-v1 fails the build if any migration creates/replaces `switch_to_tenant_by_slug` without the `open_signup` check (same pattern as S2's profile-function guard; same vitana-v1 PR). The rollback file restores the live body captured read-only before apply, not the 20250909092110 text.
- **`TENANT_MEMBERSHIP_CHECK_MODE=log` (F4):** performs the same membership lookup, emits a structured warning (`tenant_membership_mismatch`, user, tenant, route) and calls `next()`; it never skips the lookup. It exists only for the deploy window and is removed in a follow-up once `enforce` has run clean for 7 days.
- **Membership cache (F7):** the 60 s positive cache is an accepted residual: no gateway route deletes `user_tenants` rows today (verified), removal is a rare admin action, and the window is bounded; documented in Risks. Negative results are not cached.
- **Migration A assertion (F5):** `UPDATE … SET open_signup = true WHERE slug IN ('maxina','alkalma'); GET DIAGNOSTICS n = ROW_COUNT; IF n <> 2 THEN RAISE EXCEPTION …`.
- **Precision (F2, F3, F8):** overview `/activity` has a partial client-side filter that leaks events without `metadata.tenant_id`; `/alerts` is unfiltered — both become platform-only as planned. Blast radius: 157 occurrences of `requireTenant`/`requireAuthWithTenant` across 44 route files. PGlite proves SQL logic only; SECURITY DEFINER/REVOKE/GRANT behaviour is verified by the post-apply read-only `has_function_privilege` checks.

### Round-2 amendments (binding)
- **Hot-path load after the RPC fix (F9):** sized read-only 2026-10-10: 4 distinct sign-ins in 24 h, 14 in 7 d (`auth.users.last_sign_in_at`); historically the working RPC averaged 48.9 `tenant_switch` calls/day, peak 481/day; `audit_events` is 1.6 MB. Volume is negligible. Regardless, Migration C makes the steady-state path write-free: (1) `UPDATE auth.users … WHERE id = auth.uid() AND raw_app_meta_data->>'active_tenant_id' IS DISTINCT FROM tenant_record.tenant_id::text`; (2) the `audit_events` `tenant_switch` row is inserted only when that UPDATE changed a row (`GET DIAGNOSTICS` > 0) or a membership row was newly inserted; (3) membership inserts stay `ON CONFLICT DO NOTHING`. So an existing member re-entering the same tenant does 2–3 indexed SELECTs and zero writes. PGlite test asserts: second identical call → 0 rows updated, 0 audit rows added. Risks gains: "`tenant_switch` audit rows resume after a 10-month gap — expected, bounded by actual tenant changes."
<!-- plan:end -->

## Planner responses — round 1
- F1 ACCEPTED — co-ownership header + mirror Vitest guard in vitana-v1; rollback restores the captured live body. Q1: placed here because RUN-MIGRATION applies this repo's migrations; the guard prevents a vitana-v1 regression.
- F2 ACCEPTED — /activity description corrected.
- F3 ACCEPTED — 157 occurrences / 44 files.
- F4 ACCEPTED — log mode = lookup + structured warning + next(), temporary. Q2 answered.
- F5 ACCEPTED — GET DIAGNOSTICS assertion.
- F6 ACCEPTED — MaxinaPortal.tsx:328-336 is a comment; the live caller is the post-login setTenantBySlug path, now accounted for.
- F7 ACCEPTED, option (a) — 60 s residual documented; no user_tenants delete route exists today. Q3 answered.
- F8 ACCEPTED — PGlite scope noted.
- Additional (planner): live evidence shows S-E is latent because the live RPC is broken; Migration C doubles as the bug fix; behaviour change documented.

## Planner responses — round 2
- F1–F8: closed by partner.
- F9 ACCEPTED — sized (4 sign-ins/24 h, hist. avg 48.9 / peak 481 switches/day); IS DISTINCT FROM guard on the auth.users UPDATE, audit row only on real change, PGlite idempotency assertion, Risks note. Q1: yes — guard added; the steady-state path is write-free.

## Sparring verdict
Round 1: 8 findings (F1–F8) → all accepted. Round 2: F1–F8 closed; 1 new major (F9, hot-path load after RPC fix) → accepted. Round 3: all closed, no new findings. **Verdict: CONVERGED** (3 rounds).
Final plan-body hash: `cf627c91318f5d076c7f476b69673c4ab77853f54d3a0b955c977e860706c664`

## Record
- This VTID (VTID-05042) implements **§6 PR1 only** (S-L + S-F, gateway routes, no migration). Migrations A/B/C and the gateway membership check (PR2/PR3) are VTID-05043.
- Final plan-body hash (as recorded by the orchestrator at allocation): `cf627c91318f5d076c7f476b69673c4ab77853f54d3a0b955c977e860706c664`
- Sparring record: `3de60ecf-029f-4dbf-8708-c441aaef213a`. Verdict: **CONVERGED** (3 rounds).

Owner approval (Gate 1): "Yes approved" — 2026-10-10, Claude Code session; plan hash cf627c91318f5d076c7f476b69673c4ab77853f54d3a0b955c977e860706c664; sparring record 3de60ecf-029f-4dbf-8708-c441aaef213a.
