# Sparring round 2 — in_progress

Session: `03698d49-e8fc-4804-8332-b127637d9adc` · plan hash `e11aeb08a637a804f4edd4e14c0754cdc3fd5dc24c620325cb7afe8cb23dcfda`

## Summary

All five Round 1 findings were accepted and the plan addresses each at a structural level. Two new issues are introduced by the revision. The most significant is a governance/audit integrity gap: the plan re-uses the existing `emit()` helper in `admin-tenants.ts` for the new deactivate/archive OASIS events, but that helper hardcodes `vtid: PROVISION_VTID = 'VTID-05150'` — so every `tenant.deactivated`/`tenant.archived` event will be mis-attributed in the audit log. A second minor gap is that the plan drops the local `getTenantId` function from `admin-community-marketplace.ts` as part of the R1-F4 backfill, but does not specify what replaces the call to that function inside `emitAdminActivity` (line 50), leaving an underspecified implementation detail. Both gaps are directly evidenced in the pinned code.

## Findings

### R2-F1 [major]

The plan instructs deactivate/archive handlers to emit 'tenant.deactivated'/'tenant.archived' "through the existing emit() in admin-tenants.ts (:301, union widened by these two types)". That helper hardcodes `vtid: PROVISION_VTID` where `PROVISION_VTID = 'VTID-05150'` (line 193). Any tenant.deactivated or tenant.archived OASIS event emitted via this path will carry vtid:'VTID-05150' — the provisioning VTID — not the VTID of this spec. Any downstream consumer (audit, Pulse, billing) that correlates OASIS events by VTID to reconstruct which task made which lifecycle transition will see a wrong attribution.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:193` — const PROVISION_VTID = 'VTID-05150';
const OASIS_SOURCE = 'gateway/admin-tenants';
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:301` — function emit(type: 'tenant.provisioned' | 'tenant.brand_pack.updated' | 'tenant.asset.uploaded', message: string, actorId: string, payload: Record<string, unknown>) {
  return emitOasisEvent({
    vtid: PROVISION_VTID,

Suggestion: Do not reuse the existing `emit()` for deactivate/archive. Add a parallel constant `const LIFECYCLE_VTID = '<this-spec-vtid>';` and a separate `emitLifecycle()` helper (or parameterise the vtid argument of the existing one) so that `tenant.deactivated`/`tenant.archived` events carry the correct VTID. Update the Jest assertion for each handler to check that the emitted event's `vtid` field equals the lifecycle VTID, not PROVISION_VTID.

### R2-F2 [minor]

The plan drops the local `getTenantId` function (lines 30-32) from admin-community-marketplace.ts as part of the R1-F4 backfill. However, `emitAdminActivity` (lines 37-53) also calls `getTenantId(req)` at line 50 to populate the `tenant_id` field of the OASIS event payload. The plan says nothing about how this call is replaced. Using `resolveScopedTenant(req)` returns `{scope, tenantId}` — not a plain string — so the payload shape must change non-trivially. Using `req.identity?.tenant_id` directly would be flagged by the scope-helper guard test. The plan leaves this implementation detail unspecified.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:30` — function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;
}
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:44` — await emitOasisEvent({
      vtid: VTID,
      type,
      source: 'gateway',
      status: 'info',
      message,
      payload: { ...payload, tenant_id: getTenantId(req), admin_user_id: getAdminUserId(req) },

Suggestion: Explicitly specify in the backfill task what replaces `getTenantId(req)` inside `emitAdminActivity`. The safest replacement is to inline `(req as AuthenticatedRequest).identity?.tenant_id` specifically in the OASIS payload (OASIS context logging, not a scoped query), and add this pattern to the guard-test allowlist with a comment that it is an event-context-only read, not a scope-determining read. Alternatively, pass `tenantId` as a parameter to `emitAdminActivity` rather than reading it from `req`.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed at the structural level — the plan now explicitly requires emit('tenant.deactivated')/emit('tenant.archived') with Jest assertions. However the implementation vehicle chosen (reusing the existing emit() helper) introduces a new gap (R2-F1): that helper hardcodes vtid: PROVISION_VTID = 'VTID-05150', so events will carry the wrong VTID. R2-F1 is raised separately.
- R1-F2: acknowledged — Accepted and fully addressed. The plan now exports resolveScopedTenant and resolveSingleTenant from require-tenant-admin.ts, mandates their exclusive use in all lane files, and backs this with a Jest guard test. The guard test's text-match approach (regex on source) is acknowledged as not catching destructuring, but that is an acceptable trade-off given the absence of a local ESLint config — code review provides the second line of defence.
- R1-F3: acknowledged — Accepted and fully addressed. The plan now handles the /admin/init-events route entirely within vitana-v1 (mount under RouteGuard in App.tsx) with no edit to e2e/fixtures/routes.ts, eliminating the cross-repo ordering risk entirely.
- R1-F4: acknowledged — Accepted and fully addressed. Both admin-autopilot.ts (resolveSingleTenant, result-identical) and admin-community-marketplace.ts (resolveScopedTenant for /listings, resolveSingleTenant for writes) are now in the backfill scope with Jest regressions. The partial emitAdminActivity gap in admin-community-marketplace.ts that the backfill creates is raised as R2-F2.
- R1-F5: acknowledged — Accepted and corrected. The plan now cites index.ts:1433 for the invitationAcceptRouter mount.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
