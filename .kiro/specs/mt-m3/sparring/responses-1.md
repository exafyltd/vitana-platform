# Responses to sparring round 1 — mt-m3 (session 8a83bc72)

Planner: kiro-hotmail-202610151618-b437. Premises re-verified against vitana-platform `origin/main` and vitana-v1
`origin/main` (`32a82e6b68407fc1b45b7a7eca43123c9a0e067b`).

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: services/gateway/src/services/backoffice/erp-bridge-client.ts:17 (BridgeExecuteRequest) and :45 (ErpBridgeClient { execute(req) }) form an execute-only HTTP client with no bootstrap concept, and no gateway code reads erp.bootstrap_requested. Lane 6 is descoped to display-only: the admin health read (routes/admin-health.ts) reports, per tenant, whether feature_flags.erp.bootstrap_requested is set; no ERP bridge call. services/gateway/src/services/backoffice/** removed from the monitoring-erp-gw lane paths and tasks Allowed paths; tasks M2/M3, design, requirements R4.1 and plan Fix #6 / Out of scope updated. An acting consumer is deferred to a separate ERP-bootstrap spec.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: auth-supabase-jwt.ts:63-69 (runs on every request, AUTH_LOOKUP_TIMEOUT_MS = 2500), abortAfter at :71; tenant-context.ts:66-86 holds the 60s tenantMetaCache pattern. Plan Fix #2, new task H1b and the host-resolution-gw lane body now require: lookup only when MT_RESOLUTION_V2 is on AND req.hostname is not a platform host (one constant in tenant-context.ts: vitanaland.com + subdomains, localhost, staging/ALB hosts), so the default path-slug case pays nothing; a bounded host->tenant cache of hits and misses with the 60s TTL; the RPC under abortAfter(AUTH_LOOKUP_TIMEOUT_MS); timeout/error logged and the next arm runs. H3 tests cover platform-host skip, cache hit and timeout fall-through.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: 20261014000600_vtid_05151_public_tenant_registry.sql:133 defines resolve_tenant(p_slug text); its only caller is vitana-v1 src/lib/tenant-registry.ts:219 (rpc('resolve_tenant', { p_slug }), GET); the gateway has no resolve_tenant caller. docs/MULTI-TENANT-PLAN.md:52 names the anonymous RPC resolve_tenant(host, slug), so the name is kept in the parent's favour but the shape is pinned: a SEPARATE 2-arg overload resolve_tenant(p_host text, p_slug text) with NO parameter DEFAULTs. A 1-arg or {p_slug}-only call can therefore only bind the untouched 1-arg function (no ambiguous resolution). The 1-arg function is not modified; rollback drops only the overload. pgTAP pins the 1-arg output byte-identical before/after, a {p_slug}-only call binding it, and both overloads returning the same 8 columns. Plan Fix #1/Tests/Risks/open questions, tasks D2/D3, design and the tenant-domains-db lane body updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified: tenant_settings_merge_feature_flags() in 20261014000400_vtid_05150_tenant_brand_pack.sql:175-193 merges top-level with || and strips only 'jev' when p_allow_governed = false, so a tenant-admin PUT sending {\"erp\":...} would replace the stored erp object. 'erp' is declared a governed key: the provision-erp-monitoring-db migration (20261101141000) re-creates the merge function with - 'jev' - 'erp' for non-governed callers (grants unchanged; rollback restores the jev-only body). Tasks E1/E3 add a pgTAP case: a p_allow_governed=false merge sending erp leaves the stored flag intact, an exafy-admin merge still can change it. Plan Fix #5, lane body and requirements R4.1 updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Re-verified against vitana-v1 origin/main 32a82e6b: useTenant.tsx setTenantBySlug is defined at :170 (switch_to_tenant_by_slug RPC :190, refreshSession :208; :148 is a different refresh), so the plan's ':148,207' was wrong and is corrected to :170/:190/:208. permissions.ts:24 canSwitchTenant = exafy.admin && tenant.switch holds (consumed via usePermissions.ts:19). TenantManagement.tsx is an admin route (App.tsx:2158, requiredRole=\"admin\") with an exafy-admin switch section at :150; it does not reference canSwitchTenant directly, wording corrected. TenantPortal.tsx join flow is :178-193 (corrected from :190). useMemberships() with no tenantId invokes list_my_memberships (useMemberships.ts:23-30) and returns rows with tenant_id + tenants.slug, so tasks S1 now dedupes by tenant_id. Both AASA and assetlinks.json exist in public/.well-known/. Plan Problem #2, design and tasks S1 updated.",
    "deferred_to": null
  }
]
```
