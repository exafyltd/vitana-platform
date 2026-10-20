# Responses to sparring round 2 (session 2, `03698d49-e8fc-4804-8332-b127637d9adc`)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: admin-tenants.ts:193 const PROVISION_VTID = 'VTID-05150'; :301-304 emit() passes vtid: PROVISION_VTID unconditionally to emitOasisEvent. Reusing it unchanged would attribute tenant.deactivated / tenant.archived to the provisioning VTID. Fix: the lane parameterises the helper as emit(type, message, actorId, payload, vtid = PROVISION_VTID) (union widened by the two lifecycle types), so the three existing callers (:353 tenant.provisioned, :455 tenant.brand_pack.updated, :520 tenant.asset.uploaded) keep VTID-05150 unchanged, and adds const LIFECYCLE_VTID = 'VTID-xxxxx' (the tenant-admin-api lane's allocated VTID, a named TODO until PLAN-SPAR writes it) passed by both lifecycle handlers. Jest per handler asserts the event type and vtid === LIFECYCLE_VTID (not PROVISION_VTID), plus that tenant.provisioned still carries VTID-05150. Updated plan.md (tenant-admin-api Fix bullet), design.md, requirements.md R4.4, tasks.md A5 and the lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified: admin-community-marketplace.ts:30-32 local getTenantId; :37-53 emitAdminActivity builds payload { ...payload, tenant_id: getTenantId(req), admin_user_id } at :50; emitAdminActivity has 12 call sites (:89,115,148,213,226,258,269,281,315,334,352,367 plus the definition at :37). Fix (the partner's second option, no guard-test exception): emitAdminActivity gains an explicit tenantId: string | null parameter replacing the :50 read, and each call site passes the tenant its handler already resolved via resolveSingleTenant(req). The router is mounted at /api/v1/admin/community-marketplace (index.ts:1266) and no route in the file has a :tenantId param (:57,88,147,225,268,290,314,341,351), so resolveSingleTenant returns identity.tenant_id for both roles and the event payload is identical to today. The plan now also states that every other handler in the file (writes and the /reports, /categories reads) moves to resolveSingleTenant, so no direct identity.tenant_id read is left for the guard test to catch. Jest asserts an emitAdminActivity payload still carries the caller's tenant_id. Updated plan.md, design.md, tasks.md A3 and the lane body.",
    "deferred_to": null
  }
]
```
