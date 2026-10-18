# Sparring session 2 - round 1 responses (mt-data-cleanup)

Session `0bfb1038-3dea-4897-bcb1-ed6870108971` - plan hash of the s2 round-1 plan `8e78c46d01952d551e5fc125040f5247c95c35d1067df0bd0437a21babce72cc`. Every finding below is answered; all 7 accepted and applied to `plan.md`.

```json
[
    {
        "disposition":  "accepted",
        "rationale":  "Parent plan docs/MULTI-TENANT-PLAN.md line 65 (section 4.11, \"Today, verified 2026-10-10\") states chat_messages.tenant_id is already NOT NULL; WS2 line 109 lists it among hot tables only as a summary. Per the batch rule, a finding contradicting the hash-stamped parent resolves in favour of the parent. Problem #5 reworded; Lane 4 now runs a live information_schema.columns pre-check (written for Claude) and hardens only columns the pre-check reports nullable (expected: user_notifications); chat_messages orphan rows are Lane 1 remap/quarantine, not a nullability change.",
        "finding_id":  "R1-F1",
        "deferred_to":  null
    },
    {
        "disposition":  "accepted",
        "rationale":  "Verified read-only: database/migrations/20260102_vtid_01135_boundary_consent.sql:357,540 and 20260103_vtid_01144_positive_trajectory_reinforcement.sql:193,454 (plus 01137/01138/01139) set v_tenant_id := 00000000-0000-0000-0000-000000000001 on NULL fallback; 01135 reads profiles.tenant_id which premise 4 shows is NULL for all 236 members, so the fallback is unconditional today. These are pure DB objects, so repointing them is WS2 (DB) work. Added a Lane 1 step: replace the NULL-fallback with SELECT tenant_id FROM user_tenants WHERE user_id=v_user_id AND is_primary=true LIMIT 1; raise on 0/2+ memberships instead of writing 0001. New premise 7 added; Out-of-scope clarified (gateway orb-memory-bridge.ts DEV_IDENTITY stays mt-identity, these DB functions are here).",
        "finding_id":  "R1-F2",
        "deferred_to":  null
    },
    {
        "disposition":  "accepted",
        "rationale":  "current_tenant_id() is JWT-claim-dependent and NULL for browser JWTs today (parent section 4.2; parent line 65 notes chat_messages INSERT only checks sender_id=auth.uid()). Lane 4 now specifies the BEFORE INSERT fill trigger calls a direct SECURITY DEFINER lookup SELECT tenant_id FROM user_tenants WHERE user_id=auth.uid() AND is_primary=true LIMIT 1 (not current_tenant_id()), with a pgTAP test that an INSERT with no tenant_id under a claimless JWT is filled.",
        "finding_id":  "R1-F3",
        "deferred_to":  null
    },
    {
        "disposition":  "accepted",
        "rationale":  "Verified: trg_enforce_notification_type_controls is a BEFORE INSERT trigger on user_notifications that drops rows (returns NULL) when a type is disabled (DATABASE_SCHEMA.md:1085). Postgres fires BEFORE INSERT triggers alphabetically by name, so Lane 4 names the new fill trigger to sort after it (e.g. trg_zzz_tenant_fill_user_notifications), with a pgTAP test that a disabled-type notification is still dropped, not saved with a tenant_id.",
        "finding_id":  "R1-F4",
        "deferred_to":  null
    },
    {
        "disposition":  "accepted",
        "rationale":  "This is the live S-B pattern (parent section 3: DEFINER functions granted to service_role but EXECUTE never revoked from PUBLIC, so authenticated could call them). Every new SECURITY DEFINER function in this spec (analyze_orphan_rows, the trigger resolver, snapshot/move functions) now carries REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated immediately after create, with a pgTAP assertion that has_function_privilege(authenticated, \u003cfn\u003e, EXECUTE) is false for every function the spec creates.",
        "finding_id":  "R1-F5",
        "deferred_to":  null
    },
    {
        "disposition":  "accepted",
        "rationale":  "Verified: services/gateway/src/lib/vitana-bot.ts:9 exports VITANA_BOT_USER_ID = 00000000-0000-0000-0000-000000000001; the parent plan itself cites lib/vitana-bot.ts:9 at line 28 as the authoritative bot-user source. Problem #1 now cites vitana-bot.ts:9 as authoritative and keeps vitana-v1/.env:17 only as the client mirror of the same value. No logic change.",
        "finding_id":  "R1-F6",
        "deferred_to":  null
    },
    {
        "disposition":  "accepted",
        "rationale":  "The 01137/01138/01139/01144 writers insert into d43-d50 analytics tables with tenant_id = 0001 on the same NULL fallback (e.g. d45_predictive_windows at 20260103_vtid_01139_d45_predictive_risk_forecasting.sql:236, d44_predictive_signals at 20260103_vtid_01138_d44_signal_detection.sql:235). analyze_orphan_rows() already sweeps \"any other tenant table\", but the Problem baseline is now explicit: new premise 8 enumerates d43-d50 and the analyze_orphan_rows table list includes them, so the pre-check records their count (even if zero).",
        "finding_id":  "R1-F7",
        "deferred_to":  null
    }
]
```
