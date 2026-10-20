# Sparring round 3 — escalated

Session: `03698d49-e8fc-4804-8332-b127637d9adc` · plan hash `6e4964ee546339af4bb07b3ef2a9993493206eac4d7bd5ebd61790b2b2960da5`

## Summary

Round 3 review. Both R2 findings were ACCEPTED and are genuinely addressed in the revision: R2-F1 is fixed by parameterising emit(..., vtid = PROVISION_VTID) with a separate LIFECYCLE_VTID (verified: emit() at admin-tenants.ts:301-303 hardcodes PROVISION_VTID from :193, with exactly three call sites at :353/:455/:520). R2-F2 is fixed by giving emitAdminActivity an explicit tenantId parameter (verified: the dropped local getTenantId at admin-community-marketplace.ts:30-32 feeds emitAdminActivity at :50). R1-F5's citation was corrected to index.ts:1433, and R1-F1/F2/F4 are now concretely specified (shared resolver pair + guard test + two-file backfill). One new major gap remains: the "dark by default" safety argument for the admin-community-marketplace /listings backfill is not pinned to a concrete implementation point — the resolver as specified is flag-agnostic. A minor concern remains on the guard test's static-file-allowlist approach. Note: the /admin/init-events resolution and the accept-page premises depend on vitana-v1 (App.tsx, InitEvents.tsx), which has no pinned ref this session, so those claims were not verifiable against code.

## Findings

### R3-F1 [major]

The R1-F4 backfill changes admin-community-marketplace.ts /listings to use resolveScopedTenant, and the plan states 'with MT_RESOLUTION_V2 on, an exafy-admin sees the cross-tenant queue ... with the flag off (default) it keeps today's own-tenant result.' But the plan's specification of resolveScopedTenant is flag-agnostic: it returns `{ scope: 'all' }` whenever `req.identity.exafy_admin`, with no reference to MT_RESOLUTION_V2. If the resolver is implemented literally as specified and the /listings handler simply swaps getTenantId(req) for resolveScopedTenant(req), an exafy-admin ALWAYS gets scope 'all' (tenantId null → repository skips the .eq predicate), which is the cross-tenant (flag-on) behaviour — the exact opposite of the claimed dark default. The flag-check location (inside the resolver vs. a route-level branch that falls back to resolveSingleTenant when the flag is off) is never specified, so the core safety mitigation ('dark default = today's result') rests on an unspecified implementation detail.

- `exafyltd/vitana-platform:services/gateway/src/middleware/require-tenant-admin.ts:95` —     // Step 2: Exafy super-admin bypasses all tenant checks
    if (req.identity.exafy_admin) {
      next();
      return;
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:26` — const router = Router();
router.use(requireTenantAdmin);

const VTID = 'BOOTSTRAP-COMMUNITY-MARKETPLACE';

function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;
}
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:57` — router.get('/listings', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantId = getTenantId(req);

Suggestion: Specify exactly where MT_RESOLUTION_V2 is checked so the dark default holds. Either (a) make resolveScopedTenant flag-aware (return {scope:'tenant', tenantId: targetTenantId} for exafy_admin when the flag is off), or (b) require the /listings handler to branch on the flag and call resolveSingleTenant when off. Pin this with the already-listed Jest regression (flag off: exafy-admin sees own-tenant only), and add a unit test asserting resolveScopedTenant's exafy-admin branch respects the flag.

### R3-F2 [minor]

The scope-helper guard test enumerates an 'explicit list of files this lane owns' and fails only when those listed files read identity.tenant_id / targetTenantId directly. This is an allowlist, not a structural rule: any future scoped handler added outside the enumerated list (or a rename/refactor) silently escapes the guard, re-introducing the exact divergent-local pattern the spec is trying to eliminate. The earlier R1-F2 suggestion proposed an import-graph or eslint rule that excludes the bare identity.tenant_id pattern inside requireTenantAdmin-gated route files; the plan downgraded this to a static per-file list.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-autopilot.ts:23` — function getTenantId(req: Request): string {
  return (req as any).targetTenantId || (req as AuthenticatedRequest).identity?.tenant_id;
}
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:30` — function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;
}

Suggestion: Either restrict the allowed resolver access points (make targetTenantId non-exported / read-only via the helper) so the pattern cannot recur, or add a broader lint/import rule that flags identity.tenant_id / targetTenantId reads in any file that imports requireTenantAdmin, not just an enumerated allowlist. At minimum, document that the enumerated list must be extended for every future scoped handler and add a CI check that the list covers all requireTenantAdmin-gated route files.
