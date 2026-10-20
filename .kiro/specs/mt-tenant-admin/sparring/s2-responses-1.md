# Responses to sparring round 1 (session 2, `03698d49-e8fc-4804-8332-b127637d9adc`)

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: admin-tenants.ts:24 imports emitOasisEvent; :301 defines the local emit() whose type union is 'tenant.provisioned' | 'tenant.brand_pack.updated' | 'tenant.asset.uploaded'; :353-359 emits tenant.provisioned, :455 tenant.brand_pack.updated, :520 tenant.asset.uploaded. The plan's deactivate/archive handlers had no emit requirement. Fix: the tenant-admin-api lane now REQUIRES the deactivate/archive handlers to emit 'tenant.deactivated' / 'tenant.archived' through that same emit() (union widened by the two types), payload { tenant_id, slug, changed } with changed=false on an idempotent re-call, and a Jest assertion per handler. Updated plan.md (tenant-admin-api Fix bullet, Tests, Risks), design.md (What exists + tenant-admin-api), requirements.md R4.4, tasks.md A5/A6 and the lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: admin-autopilot.ts:23-24 getTenantId = targetTenantId || identity?.tenant_id; admin-community-marketplace.ts:30-31 getTenantId = identity?.tenant_id ?? null; require-tenant-admin.ts:95-99 returns for exafy_admin before :159 sets targetTenantId. Two divergent templates, both wrong for an exafy-admin list read. Fix: the lane exports two resolvers from require-tenant-admin.ts (gate and reader of its result in one file): resolveScopedTenant(req) -> {scope:'all'} for exafy_admin, else {scope:'tenant', tenantId: req.targetTenantId} (throws if unset) for list/queue reads; resolveSingleTenant(req) -> targetTenantId, or params.tenantId || identity.tenant_id for an exafy-admin, for single-tenant config endpoints. Every new scoped handler calls only these; repositories take tenantId: string | null and add the predicate only when non-null. Enforcement: Jest guard test services/gateway/test/mt-tenant-admin-scope-helper.test.ts reads an explicit list of the lane's files (new scoped handlers + the two backfilled files) and fails on a direct identity.tenant_id / identity?.tenant_id / targetTenantId read. Chosen over an ESLint rule because services/gateway has no eslint config file of its own (package.json:20 'lint': 'eslint src/**/*.ts', only @typescript-eslint plugins at :94-97, no local-rule plugin) while 'test': 'jest' (:13) already runs in the gateway CI job. require-tenant-admin.ts added to the lane paths (no other lane claims it). Updated plan.md, design.md, requirements.md R2.3, tasks.md A2/A6, lane paths + body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: e2e/fixtures/routes.ts:148 ADMIN_ROUTES, :193 '/admin/init-events', :391 admin: [...COMMUNITY_BASE_ROUTES, ...ADMIN_ROUTES] (consumed by the admin-role smoke specs, e.g. e2e/community-desktop/roles/admin/smoke.spec.ts:1); vitana-v1 src/App.tsx has no init-events/InitEvents route today. Fix (option b, made atomic by removing the split): the plan now decides GUARD, never remove: tenant-admin-pages mounts InitEvents.tsx under the admin RouteGuard at its existing path /admin/init-events. The fixture entry already lists it as admin-only, so e2e/fixtures/routes.ts is NOT edited at all: tenant-admin-api task A3 (fixture update) is removed, e2e/fixtures/routes.ts is dropped from that lane's paths, and the whole change lands in one vitana-v1 PR with no cross-repo ordering to manage. A Vitest in tenant-admin-pages asserts the route renders only through the admin guard. Updated plan.md Problem 3 + Fix + Tests, design.md, requirements.md R3, tasks.md A3/P2b, both lane bodies.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified: admin-community-marketplace.ts:26 router.use(requireTenantAdmin), :30-31 identity.tenant_id local, :61 /listings uses it, and community-marketplace-repository.ts:329-339 fetchAdminListingsQueue pins .eq('tenant_id', f.tenantId), so an exafy-admin's listings queue is own-tenant. admin-autopilot.ts:23-24 local is used by /settings, PATCH /settings and /bindings (:37,65,112); repo.fetchSettingsFull(supabase, tenantId) needs exactly one tenant, so a cross-tenant value has no meaning there. Fix, in this spec (tenant-admin-api A3): admin-autopilot.ts moves to resolveSingleTenant (identical result for both roles, Jest regression pins it); admin-community-marketplace.ts /listings moves to resolveScopedTenant, so an exafy-admin sees the cross-tenant queue when MT_RESOLUTION_V2 is on (repository .eq skipped for null) and today's own-tenant result when off (dark default, no live change before rollout); its writes move to resolveSingleTenant (unchanged). Jest regressions: exafy-admin sees T_A + T_B listings (flag on), own tenant (flag off), tenant-admin own-only either way. Both files and community-marketplace-repository.ts added to the lane paths and to the scope-helper guard list. Updated plan.md Problem 2 + Fix + Tests + Risks, design.md, requirements.md R2.3, tasks.md A3/A6, lane paths + body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified: services/gateway/src/index.ts:1429 mounts /api/v1/admin/moderation; :1433 mounts /api/v1/admin/invitations (invitationAcceptRouter, required at :503). Citation corrected to index.ts:1433 in plan.md Problem 1, requirements.md R1 and the tenant-admin-api lane; design.md now cites index.ts:503,1433.",
    "deferred_to": null
  }
]
```
