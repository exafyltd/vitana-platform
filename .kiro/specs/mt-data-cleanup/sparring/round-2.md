# Sparring round 2 — in_progress

Session: `2efa877e-46e8-4355-a2e0-d9b3c30be794` · plan hash `27f0491173ae95b3a940d15f19fcc358f7452759d2bd5186190adb419b1091fb`

## Summary

The revision correctly accepts and addresses all four R1 findings: product_analytics_events (F1) and user_notifications (F2) are rescoped to assert-and-pin with a DATABASE_SCHEMA.md fix, the function enumeration is corrected to six writers with 01142/01143 confirmed as non-writers and 01127 discovered (F3), and R1-F4 is addressed with a precondition gate + local-stack call-tests + read-only post-check. Premises 1 (DEV_IDENTITY), 3 (VITANA_BOT_USER_ID), 5 (NOT NULL DDL), and 7 (six, not five, writer migrations) all hold against the code. However, the rewritten Lane 1 repoint scope has a new gap: the 01127 availability functions carry a second fallback `v_user_id := '…0099'` on the NULL-JWT path that writes the dev test user as a real `user_id`, which the plan's repoint (only the `v_tenant_id` branch) does not touch. That re-pollutes availability tables with `user_id = …0099` while simultaneously asserting zero-orphan/zero-dev rows.

## Findings

### R2-F1 [major]

The 01127 availability writer functions carry a second NULL fallback that the repoint does not address: on the NULL-JWT path they set `v_user_id := '00000000-0000-0000-0000-000000000099'` (the dev test user) in addition to `v_tenant_id := '…0001'`. Premise 1/7 and Lane 1 task O8 only rewrite the `v_tenant_id := '…0001'` branch into a `user_tenants` lookup. The `v_user_id := '…0099'` fallback is left intact, so any invocation where `auth.uid()` is NULL (e.g. `request.jwt.claims` sub missing, same path that triggers the tenant fallback) will INSERT availability rows with `user_id = '…0099'`, re-polluting `availability_assessments`/`availability_overrides` with dev-user rows immediately after the cleanup and the zero-orphan post-check asserts none exist. The plan's own premise 1 treats `user_id = …0099` as 'dev test data', and Lane 1 explicitly routes `…0099`-owned rows to quarantine — yet the repoint leaves a live writer that recreates them.

- `exafyltd/vitana-platform:supabase/migrations/20260102200000_vtid_01127_availability_readiness_engine.sql:267` —     v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;
- `exafyltd/vitana-platform:supabase/migrations/20260102200000_vtid_01127_availability_readiness_engine.sql:417` —     IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;
- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge.ts:66` —     USER_ID: '00000000-0000-0000-0000-000000000099',
    // Vitana tenant (primary dev tenant)
    TENANT_ID: '00000000-0000-0000-0000-000000000001',

Suggestion: In the 01127 functions, either (a) fail closed on a NULL v_user_id the same way the tenant branch will (raise / return {ok:false,error:'UNAUTHENTICATED'} instead of defaulting to …0099), or (b) explicitly include the `v_user_id := '…0099'` fallback in the repoint scope and in the pgTAP call-tests, and add `user_id = '…0099'` to the zero-orphan post-check for the availability tables. The plan's premise-7 line enumerations (271,356,418,497,542) already cite these blocks; the repoint must clear BOTH the tenant and the user fallbacks in them.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Addressed: product_analytics_events removed from expand/contract; Lane 4 rescoped to assert-and-pin plus DATABASE_SCHEMA.md:2542 marker fix. Premise 5 now correctly states the column is NOT NULL.
- R1-F2: acknowledged — Addressed: user_notifications rescoped out of backfill/trigger; the assertion-only migration and DATABASE_SCHEMA.md fix are coherent given Kiro cannot run SQL. The information_schema pre-check deferred to Claude via the assertion resolves the no-live-SQL limitation.
- R1-F3: acknowledged — Addressed: verified 01142/01143 are non-writers (my read confirms no …0001 fallback, no INSERT into tenant-keyed tables), and the full grep rightly surfaced 01127 (six migrations). The revised premise 7 line enumerations are accurate.
- R1-F4: acknowledged — Addressed with a sound adaptation to the read-only staging rule: precondition DO-block gate + local-stack pgTAP call-tests + read-only pg_get_functiondef post-check. The rationale for not calling writers on staging is valid.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
