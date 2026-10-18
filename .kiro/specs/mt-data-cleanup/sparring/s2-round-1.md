# Sparring round 1 — in_progress

Session: `0bfb1038-3dea-4897-bcb1-ed6870108971` · plan hash `8e78c46d01952d551e5fc125040f5247c95c35d1067df0bd0437a21babce72cc`

## Summary

The plan has one blocker: Lane 4's central premise that chat_messages.tenant_id is nullable is directly contradicted by the program plan's own verified starting-state section (MULTI-TENANT-PLAN.md §4.11, line 65: "chat_messages.tenant_id is NOT NULL"). Four major defects follow: the five live NULL-fallback DB functions that produced the orphan rows are never patched so cleanup will be re-polluted; the Lane 4 BEFORE INSERT trigger's tenant resolution mechanism is unspecified and the only available resolver returns NULL for all browser JWTs today; Lane 4's new BEFORE INSERT trigger on user_notifications does not address its interaction with the existing trg_enforce_notification_type_controls BEFORE INSERT trigger; and the new SECURITY DEFINER functions are not explicitly shown to REVOKE EXECUTE FROM PUBLIC/anon/authenticated, repeating the exact S-B vulnerability pattern. Two minor issues: the bot-user-ID citation points to the wrong repo/file, and the d43-d50 tables produced by the NULL-fallback writers are absent from the Problem-section row counts.

## Findings

### R1-F1 [blocker]

Lane 4's expand/contract NOT NULL work for chat_messages rests on a false premise. MULTI-TENANT-PLAN.md §4.11 — the section explicitly labelled 'Today (verified 2026-10-10, code + live policies)' — states: 'chat_messages.tenant_id is NOT NULL'. The sub-plan's Problem §5 says the opposite: 'chat_messages … have nullable tenant_id'. Applying the expand/contract migration to a column that already carries NOT NULL will either fail at the SET NOT NULL step or produce a silent no-op after spending off-peak window and lock budget. WS2 of the program plan (line 109) does repeat 'NOT NULL via §4.7 on hot tables (chat_messages …)', so the sub-plan is following WS2 literally without reconciling it against the §4.11 verified current state — an internal contradiction in the parent plan that must be resolved with a live information_schema.columns check before Lane 4 is written.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:65` — chat_messages.tenant_id is NOT NULL; its RLS is participant-based, and **INSERT only checks `sender_id = auth.uid()`**
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:109` — NOT NULL via §4.7 on hot tables (chat_messages 49k, user_notifications 83k; product_analytics_events via insert default, no client RLS)

Suggestion: Before writing Lane 4, run SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('chat_messages','user_notifications') AND column_name = 'tenant_id' against the live DB and pin the result in the pre-check. If chat_messages.tenant_id is already NOT NULL, remove it from Lane 4's expand/contract scope; its orphan rows (305 under non-existent tenant …0001) are Lane 1 work (remapping/quarantining), not a nullability problem. Reconcile the internal contradiction between MULTI-TENANT-PLAN.md §4.11 and WS2 before implementation begins.

### R1-F2 [major]

All five NULL-fallback writer functions are still deployed and callable after this plan's cleanup completes, so new orphan rows under …0001 can be created immediately. Migration 01135 reads profiles.tenant_id (line 355) which is NULL for all 236 live members (the plan's own Problem §4 states this); its fallback to …0001 is therefore unconditional for every current member who calls it. The other four (01137–01139, 01144) read auth.users.raw_user_meta_data->>'tenant_id', which may also be NULL. None of these DB functions are patched in this spec's four lanes. The plan's Out of scope defers only the CODE-side DEV_IDENTITY removal in orb-memory-bridge.ts. The five functions are pure DB objects — rewriting them is DB work and belongs in a WS2 lane. Without this fix the 'zero orphan rows' post-check is guaranteed to fail after the first member invocation of any of these functions.

- `exafyltd/vitana-platform:database/migrations/20260102_vtid_01135_boundary_consent.sql:354` — SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::UUID; -- Default tenant
    END IF;
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01144_positive_trajectory_reinforcement.sql:186` — SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

Suggestion: Add a Lane 0 or amend Lane 1 to replace the NULL-fallback in all five functions with a lookup against the canonical user_tenants table: SELECT tenant_id FROM user_tenants WHERE user_id = v_user_id AND is_primary = true LIMIT 1. If the lookup returns NULL (0 or 2+ memberships), the function should return an error, not silently write …0001. This fix must land before or alongside Lane 1.

### R1-F3 [major]

Lane 4's BEFORE INSERT trigger 'filling tenant_id from the actor's resolved tenant' has no specified resolution mechanism, and the only resolver that is live today (current_tenant_id()) returns NULL for every browser JWT. MULTI-TENANT-PLAN.md §4.2 explains that the new token hook which would emit tenant_id in the JWT is WS1 work broader than membership-unification. The plan's Depends on section lists only membership-unification, not the full auth-hook activation. If the trigger calls current_tenant_id(), every browser INSERT during the backfill window will write NULL, immediately violating the NOT NULL constraint the trigger is supposed to satisfy.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:52` — Resolution chain (one implementation): host … → primary user_tenants row. Unresolved → reject … Tenant context in tokens — one claim, one source of truth: a Supabase Custom Access Token Hook reads the user's active user_tenants membership
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:58` — Pattern: expand/contract only — nullable column → BEFORE INSERT trigger filling tenant from the actor's resolved tenant

Suggestion: Specify the exact resolver the BEFORE INSERT trigger calls: it must be a direct SECURITY DEFINER lookup SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid() AND is_primary = true LIMIT 1 (not current_tenant_id(), which is JWT-dependent and currently NULL). Add this as explicit trigger body pseudocode in the lane spec, and add a pgTAP test that fires an INSERT with no tenant_id while a JWT with no tenant_id claim is in effect.

### R1-F4 [major]

Lane 4's BEFORE INSERT trigger on user_notifications will conflict with the existing trg_enforce_notification_type_controls BEFORE INSERT trigger on the same table, which is confirmed in production. That trigger returns NULL (drops the row) when the admin or member switch is off. PostgreSQL fires BEFORE INSERT triggers in alphabetical order by name. The plan names neither trigger explicitly nor specifies their relative ordering, risking the tenant-fill trigger running on rows that will be dropped or the notification-controls trigger seeing rows without a filled tenant_id.

- `exafyltd/vitana-platform:DATABASE_SCHEMA.md:1085` — **Trigger:** `trg_enforce_notification_type_controls` runs BEFORE INSERT on
`user_notifications`. It drops the row (returns NULL) and counts it when the
admin switch is off or the member switched the category off. On an internal
error it fails open with a WARNING.

Suggestion: Name the new tenant-fill trigger so it sorts alphabetically after trg_enforce_notification_type_controls (e.g. trg_zzz_tenant_fill_user_notifications) to ensure the existing drop-row logic runs first. Add a pgTAP test that inserts a notification for a disabled type and asserts the row is dropped (not saved with a tenant_id). Document the trigger ordering rationale in the migration comment.

### R1-F5 [major]

The plan creates new SECURITY DEFINER functions (including analyze_orphan_rows() and the lane snapshot/move functions) but does not explicitly state that EXECUTE is revoked from PUBLIC, anon, and authenticated. This is the exact gap that produced the live S-B vulnerability documented in MULTI-TENANT-PLAN.md §3: 'migrations grant only service_role but EXECUTE was never revoked from PUBLIC … → any signed-in member reads/poisons any user's memory facts.' Creating new SECURITY DEFINER functions without explicit revokes will reproduce S-B.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:38` — write_fact, get_current_facts, recall_at_time_range, memory_facts_semantic_search: SECURITY DEFINER, no caller check; the migrations grant only service_role but EXECUTE was never revoked from PUBLIC, and live has_function_privilege('authenticated', …) = true (verified 2026-10-06)

Suggestion: Every new SECURITY DEFINER function in all four lanes must include REVOKE EXECUTE ON FUNCTION <name> FROM PUBLIC, anon, authenticated immediately after CREATE OR REPLACE FUNCTION. Add a pgTAP assertion that has_function_privilege('authenticated', '<name>(...)', 'EXECUTE') returns false for every function created in this spec.

### R1-F6 [minor]

The plan cites vitana-v1/.env:17 VITE_VITANA_BOT_USER_ID as the source establishing …0001 as the bot user ID. The authoritative definition is services/gateway/src/lib/vitana-bot.ts:9 in vitana-platform (confirmed). MULTI-TENANT-PLAN.md §2 also cites lib/vitana-bot.ts:9. The vitana-v1 repo has no pinned ref in this review session, and a client .env variable is not the server-side authoritative source.

- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-bot.ts:9` — export const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:28` — …0001 is BOTH the dev tenant id (orb-memory-bridge.ts:66-70) AND the bot user id (lib/vitana-bot.ts:9)

Suggestion: Correct the citation in Problem §1 to services/gateway/src/lib/vitana-bot.ts:9. No logic change needed — the value is correct.

### R1-F7 [minor]

The four NULL-fallback writer migrations (01137, 01138, 01139, 01144) each insert rows into the D43–D50 analytics tables (d43_longitudinal_data_points, d44_predictive_signals, d45_predictive_windows, d50_positive_reinforcements) with tenant_id = …0001 when the user has no tenant in metadata. These tables are not enumerated in the Problem section's orphan counts — only memory_facts, chat_messages, memory_items, user_notifications and 3 rows under fake 550e8400 are listed. The analyze_orphan_rows() 'any other tenant table' clause should catch them at runtime, but the pre-check baseline in the plan is incomplete.

- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01139_d45_predictive_risk_forecasting.sql:236` — INSERT INTO d45_predictive_windows (
        id, tenant_id, user_id, window_type, domain, time_horizon,
        start_time, end_time, confidence, severity, leverage,
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01138_d44_signal_detection.sql:235` — INSERT INTO d44_predictive_signals (
        tenant_id, user_id, signal_type, confidence, time_window,
        detected_change, user_impact, suggested_action, explainability_text,

Suggestion: Explicitly enumerate d43–d50 orphan counts in the Problem section's verified baseline (even if all are zero, record that). Add them to the analyze_orphan_rows() table list. Pin the count in the pre-check SQL.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
