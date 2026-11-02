# Responses to round 1

```json
[{"finding_id":"R1-F1","disposition":"accepted","rationale":"Correct: as written the helper returned false for a NULL current_tenant_id(), so the policy fell back to is_active only and the 'gate on + NULL tenant -> network only' pgTAP assertion could never hold. Took option (a): for a NULL tenant discover_tenant_gate_enabled() returns EXISTS(tenant_settings row with feature_flags->'mt'->>'discover_tenant_gate' = true); for a non-NULL tenant it keeps the per-tenant flag. With every gate off (today; tenant_settings.feature_flags defaults to '{}', 20260412300000_tenant_settings.sql:12) the helper is false for every session and the policy equals today's is_active-only policy (foundation.sql:729/:735). plan.md (DB section + pgTAP test plan) and tasks.md D4 plus a new acceptance entry updated; lane supplier-relationships-db paths unchanged.","deferred_to":""},
 {"finding_id":"R1-F2","disposition":"accepted","rationale":"Correct: merchants_select is created at 20260416120000_vtid_02000_marketplace_foundation.sql:729 and products_select at :735. plan.md and tasks.md D4 now name each policy with its own line.","deferred_to":""}]
```
