# Responses to sparring round 1 (session 2, `0de6a378-b304-4d63-b75b-3813dfcfbf75`)

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: no services/tenant-launch/ directory exists at the repo root, while the modelled files live at services/gateway/src/services/data-export-consent.ts (:83 tenantExportPolicy) and data-export-consent-repository.ts (:24 fetchTenantSettingsFeatureFlags). tasks.md and the pack-intake-admin lane paths already carried the full path, but plan.md, design.md and three lane bodies used the abbreviated one. Every occurrence now reads services/gateway/src/services/tenant-launch/tenant-feature-flag.ts (plan.md Fix x3, design.md, pack-intake-admin, tenant-owner-analytics and support-landing lane bodies).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified the two precedents use named deny lists (vtid-05156-people-match-health-boundary.test.ts:23 HEALTH_TABLES regex; vtid-05025 :7). The plan now enumerates the read allowlist for owner-analytics: product_analytics_events (20260612140000_BOOTSTRAP_product_analytics_events.sql:18), product_analytics_daily_rollups (20260612140100_BOOTSTRAP_product_analytics_rollups.sql:8), tenant_pack_intake, tenant_content_pipeline, tenants, and RPC get_tenant_launch_readiness. The guard extracts every .from('…')/.rpc('…') identifier in the scanned files and fails on any name outside that list, with the inline HEALTH_TABLES deny regex as a second explicit check (moved to mt-identity isHealthTable() once it ships). Adding a table is a reviewed one-line test edit. Updated plan.md Tests, design.md, tasks.md P2, tenant-owner-analytics lane.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified no migration in supabase/migrations creates tenant_content_overrides at this tip (it is mt-packs' table). The publish repository call now maps a missing-relation error (Postgres 42P01, PostgREST PGRST205 'Could not find the table') to a typed DEPENDENCY_NOT_READY result: the handler answers 409 { ok:false, error:'DEPENDENCY_NOT_READY', dependency:'tenant_content_overrides' }, the row stays signed_off (no state change, no partial write) and an OASIS tenant.content.publish_blocked event is emitted, independent of the mt.launch_pipeline flag, so no uncaught 500. Jest pins both error codes. Chosen over a to_regclass pre-check because PostgREST cannot run to_regclass without a new RPC, and mapping the error covers the same case with no extra round trip. Updated plan.md Fix + Risks, design.md, tasks.md P5/P6, pack-intake-admin lane.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified community-invites.ts:72-80: on 'attributed' the /claim route emits community_autopilot.invite.{attributed,rewarded} with vtid 'SYSTEM' and payload referral_id, referred_id, rewarded, reward_reason, no tenant; the route requires identity.user_id (:55). Fix: the support-landing lane adds tenant_id to that payload = the claiming member's verified identity.tenant_id, else resolvePrimaryTenant(identity.user_id) (services/tenancy/tenant-context.ts:43), unresolved => null, never DEFAULT_TENANT_ID, behind mt.launch_support; Jest proves a non-default-tenant claim carries its own tenant. community-invites.ts added to the lane paths (no other lane claims it). Scope correction made in the same pass: admin-signups.ts:205 (signup/referral dispatch pinned to DEFAULT_TENANT_ID) is now owned by mt-jobs lane jobs-automation-actor-tenant (VTID-05267, approved 2026-10-20, its paths include routes/admin-signups.ts), which resolves the new user's auth_user_id primary tenant; this spec no longer edits that file, to avoid two lanes editing the same lines. The stale 'already tenant-scoped, keep' notes in design.md, requirements.md (support/landing requirement 2), tasks.md P3 and the lane are corrected. Updated plan.md Problem/Fix/Risks, design.md, requirements.md, tasks.md P3b/P4, support-landing lane.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "The only caller of get_tenant_launch_readiness is the gateway under the service role, which already reads both service-role-only tables, so privilege elevation is unnecessary: the function becomes SECURITY INVOKER (removing the definer hijack vector outright), STABLE, with SET search_path = public, pg_catalog pinned in the definition (repo precedent supabase/migrations/20251228000000_vtid_01050_dev_bootstrap_context.sql:23), owned by the migration role, REVOKE EXECUTE FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role. pgTAP checks prosecdef = false, proconfig contains the search_path, and anon/authenticated lack EXECUTE. Updated plan.md Fix/Migrations/Tests, design.md, tasks.md P3, pack-intake-db lane.",
    "deferred_to": null
  }
]
```
