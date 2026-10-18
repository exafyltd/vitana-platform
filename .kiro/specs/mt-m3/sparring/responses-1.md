# Responses to sparring round 1 — mt-m3

Planner: kiro-hotmail-202610151618-b437. Every premise re-verified against `origin/main`
(`8fdcbf47576737e970e4eb9a9c5021267bbe0e0b`) and the concurrent plan branches today.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: `.kiro/specs/mt-tenant-admin/` does not exist on main (ls-tree origin/main returns nothing) nor on this plan branch tip. It exists only on sibling plan branch `kiro/mt-tenant-admin/plan` (6387a912d6eb243b7d5be5875c0ab6af8e480935), whose `lanes/tenant-lifecycle-db.md` owns `deactivate_tenant(slug)`/`archive_tenant(slug)` + the closing switch RPC (migrations 20261101070300/070350). The plan's claim 'verified in .kiro/specs/mt-tenant-admin/tasks.md' overstated a not-yet-merged artifact as proven. Fixed: Problem #7 and Depends-on now say mt-tenant-admin is a concurrent, unmerged sibling plan branch per CROSS-SPEC O2, the runbook references the RPCs by signature only and degrades to a documented TODO if it implements first. mt-m3 does not re-verify or redefine those RPCs.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified against docs/multitenancy/MIGRATION-QUEUE.md on main: the live queue ends at row 8 (20261014000700, VTID-05151 M2); its header lists ranges only for S-M/A/B/C; there is no mt-tenant-admin block and no `070600`/`0701xx` reservations. The plan's ordering anchor ('after mt-tenant-admin's 070600 block and after every 0701xx reservation') pointed at rows that do not exist in the live queue. Fixed with a concrete rule in ## Migrations and tasks.md D4: append after the current live last row and add an mt-m3 header range note (20261101140000-145959). Note mt-m3's own 1101140000+ range sorts strictly after any mt-tenant-admin 070xxx rows, so no re-position is required whether that spec merges first or not — removing the dependency on an unmerged reservation entirely.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: tenant-context.ts:22 defines `TenantSource = 'token' | 'exafy_admin_token' | 'primary' | 'membership_fallback'` with no 'host' variant, and TenantContext.source: TenantSource (:28). The type is consumed in the middleware the lane edits — auth-supabase-jwt.ts:35 (import), :579 (PrimaryTenantOutcome), :607 (tokenTenantOrigin return), :617 (source param). Adding a host arm requires adding 'host' to the union and updating those consumers or TS fails to compile. Fixed: plan Fix #2, tasks.md H1 and the host-resolution-gw lane body now call out the union extension and the exact consumer audit (file:line).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified: provision_tenant's tenant_settings INSERT uses `ON CONFLICT (tenant_id) DO NOTHING` (20261014000500_vtid_05150_provision_tenant.sql ~:154-165). The plan proposes the ERP flag as a feature_flags JSONB key (feature_flags.erp.bootstrap_requested) — exactly the case the conflict-skip would silently drop on an already-provisioned re-run. Fixed: plan Fix #5, tasks.md E1 and the provision-erp-monitoring-db lane body now specify a guarded UPDATE with jsonb_set AFTER the INSERT (`WHERE tenant_id = v_tid AND NOT (feature_flags #> '{erp,bootstrap_requested}' = 'true')`), and tasks.md E3 pins a pgTAP assertion that the flag is set on BOTH first-run and a re-run on an already-provisioned tenant.",
    "deferred_to": null
  }
]
```
