# Sparring round 1 — in_progress

Session: `c95e0294-6627-45dc-8caa-27cc7bcf09c2` · plan hash `1ffc051c15dd07e062719a41fe0cedf73066c1ef89292081eb63ab545028439b`

## Summary

Eight premises verified against the pinned commit across six files read with read_file. Two major findings and two minor findings. The most serious: `.kiro/specs/mt-tenant-admin/` does not exist at the pinned commit, yet the plan claims to have "verified" cross-spec O2 RPCs there and builds the offboarding runbook lane on that anchor. MIGRATION-QUEUE.md confirms this: its header lists only S-M/A/B/C lane ranges with no mt-tenant-admin block; the plan's migration-ordering instruction points at queue rows that don't exist. Two minor gaps: the `TenantSource` union type has no 'host' discriminant (unmentioned in the plan) and the ERP bootstrap idempotency mechanism is unspecified given the existing `ON CONFLICT DO NOTHING` in `provision_tenant`.

## Findings

### R1-F1 [major]

`.kiro/specs/mt-tenant-admin/tasks.md` does not exist at the pinned commit. The plan states it 'verified' cross-spec O2 (`deactivate_tenant`/`archive_tenant` + closing switch RPC) in that file, and the `wizard-price-polish` runbook lane is built on that anchor. The MIGRATION-QUEUE.md — which every multi-tenant spec must register in — shows only four lane ranges (S-M, A, B, C) covering VTID-05147/05149/05150/05151, with no mt-tenant-admin entry of any kind. The RPCs the runbook doc will reference are unproven in the codebase.

- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:11` — Lane number ranges: S-M `20261013233000`; A `20261014000100`–`000300`;
B `20261014000400`–`000500`; C `20261014000600`–`000700`.
- `exafyltd/vitana-platform:supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:22` — -- Never touched: auth.users, app_users, user_tenants, memberships, profiles,
-- chat_messages, user_notifications, founding tables — so no member fan-out
-- trigger can fire (those are AFTER INSERT on user_tenants only).

Suggestion: Before this plan is approved: (a) confirm whether mt-tenant-admin has been specced and add the actual path to its tasks.md to the Depends-on front matter so the cross-spec anchor is real; (b) if mt-tenant-admin is not yet specced, the offboarding runbook lane must either be deferred until those RPCs exist or written as explicit stubs with a TODO referencing the future spec rather than claiming to reference proven RPCs. Remove the 'verified in `.kiro/specs/mt-tenant-admin/tasks.md`' claim.

### R1-F2 [major]

MIGRATION-QUEUE.md ends at row 8 (`20261014000700`, VTID-05151 M2) with no mt-tenant-admin entries and no reserved ranges for `070600` or `0701xx`. The plan's migration-ordering instruction — 'after mt-tenant-admin's `070600` block and after every mt-* `0701xx` reservation' — points at queue rows that do not exist. An implementer following this instruction has no valid anchor in the real queue and will either mis-position the new rows or block indefinitely waiting for a spec that may ship after mt-m3.

- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:23` — | 8 | `20261014000700_vtid_05151_seed_legacy_tenant_landing.sql` | C / VTID-05151 (M2) | #7 | `docs/validation/VTID-05151/rollback-seed.sql` | right after #7 | applied 2026-10-13 (RUN-MIGRATION 38459959764), post-check clean
- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:11` — Lane number ranges: S-M `20261013233000`; A `20261014000100`–`000300`;
B `20261014000400`–`000500`; C `20261014000600`–`000700`.

Suggestion: Replace the unanchored ordering instruction with a concrete rule: 'Append after existing row 8 (20261014000700). If mt-tenant-admin queue rows are added before this PR merges, re-position after the last mt-tenant-admin row at that time.' Add a new lane-number-range note in MIGRATION-QUEUE.md's header for the mt-m3 range (`20261101140000–20261101145959`), exactly as S-M/A/B/C are recorded.

### R1-F3 [minor]

The existing `TenantSource` union type is `'token' | 'exafy_admin_token' | 'primary' | 'membership_fallback'` and `TenantContext` carries `source: TenantSource` with no `'host'` variant and no `host` field. The plan directs adding a host arm to `TenantContext` resolution but nowhere mentions extending `TenantSource` or auditing exhaustive consumers. Any TypeScript code that exhaustively switches on `TenantSource` (logging, metrics, test assertions) will fail to compile once the new value is added without corresponding updates.

- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:22` — export type TenantSource = 'token' | 'exafy_admin_token' | 'primary' | 'membership_fallback';
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:24` — export interface TenantContext {
  tenantId: string;
  slug: string | null;
  role: string | null;
  source: TenantSource;
  isPlatform: boolean;
}

Suggestion: The `host-resolution-gw` lane task list must explicitly include: (1) add `'host'` to `TenantSource`; (2) search for exhaustive `switch (ctx.source)` consumers in the gateway and add the `'host'` case; (3) decide whether `TenantContext` needs a `resolvedHost?: string` field for downstream logging. These are small but must appear in the lane's task list to avoid a TypeScript compilation break.

### R1-F4 [minor]

`provision_tenant` uses `ON CONFLICT (tenant_id) DO NOTHING` for the `tenant_settings` INSERT (line 164). The plan says the `provision-erp-monitoring-db` lane will 'extend `provision_tenant()` to record the §4.6 ERP bootstrap request (idempotent)'. On an idempotent re-run for an already-provisioned tenant the entire `tenant_settings` INSERT is silently skipped, so an ERP flag written only inside that INSERT block will never be recorded for existing tenants. The plan does not state whether the ERP record is a JSONB key in `feature_flags` (affected by the skip), a separate table row (not affected), or needs an additional UPDATE path.

- `exafyltd/vitana-platform:supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:154` — INSERT INTO public.tenant_settings (
      tenant_id, display_name, default_locale, enabled_locales, timezone, currency,
      feature_flags, provisioned_at, provisioned_by, updated_at, updated_by)
    VALUES (
      v_tid, coalesce(nullif(btrim(p_display_name), ''), v_name), p_default_locale, v_locales, p_timezone, p_currency,
      jsonb_build_object('jev', jsonb_build_object(
        'enabled', true,
        'planes', jsonb_build_array('internal', 'system_autopilot', 'member'),
        'monthly_budget_usd', p_jev_monthly_budget_usd)),
      now(), p_invited_by, now(), p_invited_by)
    ON CONFLICT (tenant_id) DO NOTHING;

Suggestion: The `provision-erp-monitoring-db` lane must specify the idempotency mechanism explicitly. If the ERP bootstrap flag is a JSONB key in `feature_flags`, a separate `UPDATE tenant_settings SET feature_flags = feature_flags || '{"erp_bootstrap_requested":true}' WHERE tenant_id = v_tid AND NOT (feature_flags ? 'erp_bootstrap_requested')` is needed after the INSERT. The lane's pgTAP test for 'provision_tenant records the ERP request idempotently' must exercise the re-run path on an already-provisioned tenant.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
