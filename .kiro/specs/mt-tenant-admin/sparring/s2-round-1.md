# Sparring round 1 — in_progress

Session: `03698d49-e8fc-4804-8332-b127637d9adc` · plan hash `45869d431af17f091c9157cbc1bdd741e86b06fb0885f3430858166ecc4df31d`

## Summary

The plan's factual premises about the existing codebase are largely accurate. The accept route, middleware behaviour, guard script, fixture file, and readiness endpoint all match the cited lines. Four substantive issues were found: (1) no OASIS event requirement for the new deactivate/archive gateway actions, breaking the pattern already established by provisioning; (2) no shared `getTargetTenantId` utility, creating N independent implementation sites for the two-branch exafy_admin check where any missed branch is a silent tenant-scoping bug; (3) the `/admin/init-events` fixture update and RouteGuard change are split across two repos in two lanes with no merge-ordering constraint; (4) existing `requireTenantAdmin`-gated files (`admin-community-marketplace.ts`, `admin-autopilot.ts`) already carry the broken exafy-admin silent-scoping pattern and are not fixed or tracked, leaving an inconsistent platform state after this spec ships. One minor wrong line number is also flagged.

## Findings

### R1-F1 [major]

The plan specifies new gateway deactivate/archive routes in the tenant-admin-api lane but contains no requirement to emit OASIS events. The provisioning endpoint already establishes the mandatory pattern (emit('tenant.provisioned', …) at admin-tenants.ts:353–359). Deactivation and archival are higher-stakes lifecycle state changes; any downstream consumer watching for tenant.* events (audit, Pulse, billing) will be silently blind to these transitions.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:353` — await emit('tenant.provisioned', `Tenant ${r?.slug} ${created ? 'provisioned' : 're-checked (already provisioned)'}`, auth.user_id, {
        tenant_id: r?.tenant_id,
        slug: r?.slug,
        created,
        invitation_id: r?.invitation?.id ?? null,
        ensured: r?.ensured ?? null,
      });
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:24` — import { emitOasisEvent } from '../services/oasis-event-service';

Suggestion: Add an explicit 'tenant.deactivated' and 'tenant.archived' emit() call (matching the provisioning pattern) to the deactivate/archive gateway handlers as a hard requirement in the tenant-admin-api lane spec, and add a Vitest assertion that each handler emits the event.

### R1-F2 [major]

The plan mandates in prose that every new scoped endpoint must implement the two-branch exafy_admin check, but requires no shared utility or lint rule. Two conflicting reference implementations already exist in the codebase: admin-autopilot.ts:23–24 uses `targetTenantId || identity.tenant_id` (broken for exafy-admins), while admin-community-marketplace.ts:30–31 reads `identity.tenant_id` only (also broken). Any implementer who copies either file as a template produces a silent scoping bug. The plan calls this pattern out as a risk but offers only a prose mandate across N handlers.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-autopilot.ts:23` — function getTenantId(req: Request): string {
  return (req as any).targetTenantId || (req as AuthenticatedRequest).identity?.tenant_id;
}
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:30` — function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;
}
- `exafyltd/vitana-platform:services/gateway/src/middleware/require-tenant-admin.ts:95` — // Step 2: Exafy super-admin bypasses all tenant checks
    if (req.identity.exafy_admin) {
      next();
      return;
    }

Suggestion: Require the tenant-admin-api lane to introduce a single exported helper (e.g., `resolveTargetTenantId(req): string | null`) that encapsulates the exafy_admin branch. All new handlers and any backfill of existing requireTenantAdmin handlers must call this helper exclusively. Add a Vitest import-graph or eslint rule that disallows the bare `identity.tenant_id` pattern inside requireTenantAdmin-gated route files.

### R1-F3 [major]

The plan splits the `/admin/init-events` fix across two lanes in two separate repos with no stated merge-ordering constraint: the `e2e/fixtures/routes.ts` entry update is owned by tenant-admin-api (vitana-platform), while the RouteGuard addition or page removal is owned by tenant-admin-pages (vitana-v1). The route-inventory test in vitana-platform reads the fixture and checks vitana-v1 routes. Between the two merges, whatever state the test exercises could be inconsistent. The fixture entry is confirmed present today at line 193.

- `exafyltd/vitana-platform:e2e/fixtures/routes.ts:193` —   '/admin/init-events',
];
- `exafyltd/vitana-platform:e2e/fixtures/routes.ts:148` — export const ADMIN_ROUTES: string[] = [
  // Dashboard
  '/admin/dashboard',

Suggestion: Either (a) make the fixture update and the App.tsx RouteGuard/removal a single coordinated PR with an explicit cross-repo dependency gate, or (b) move the fixture update into the tenant-admin-pages lane so both changes land atomically. Add a lane-ordering constraint stating tenant-admin-pages must merge before or simultaneously with the tenant-admin-api fixture change.

### R1-F4 [major]

The plan correctly identifies that admin-community-marketplace.ts and admin-autopilot.ts already carry the broken exafy-admin silent-scoping pattern (both use requireTenantAdmin, which returns early for exafy-admin at line 96, then read identity.tenant_id rather than targetTenantId). The plan explicitly does not fix these files and does not schedule a follow-up VTID. After this spec ships, these routes remain in a state where an exafy-admin call is silently scoped to their own (likely platform or default) tenant — the exact bug the spec claims to mitigate for new endpoints. The inconsistency leaves the platform in a partially repaired state with no stated remediation path.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:26` — router.use(requireTenantAdmin);

const VTID = 'BOOTSTRAP-COMMUNITY-MARKETPLACE';

function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;
}
- `exafyltd/vitana-platform:services/gateway/src/middleware/require-tenant-admin.ts:159` —     // Attach the resolved target tenant for downstream handlers
    (req as any).targetTenantId = targetTenantId;
    next();

Suggestion: Add a backfill task (or a separate VTID placeholder) within this spec to fix admin-community-marketplace.ts and admin-autopilot.ts to use the correct two-branch pattern (or the new shared helper from R1-F2). At minimum, add a Vitest regression for these existing files asserting that an exafy-admin sees cross-tenant rows, not just own-tenant rows.

### R1-F5 [minor]

The plan states the acceptRouter is 'mounted at `/api/v1/admin/invitations` (`index.ts:1429`)'. Line 1429 is the admin moderation router mount; the invitation accept router is at line 1433.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:1428` —     // Admin: Content Moderation
    mountRouterSync(app, '/api/v1/admin/moderation', adminModerationRouter, { owner: 'admin-moderation' });

    // Batch 1.B1: Tenant Invitations — per-tenant invite/accept flow
    mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/invitations', tenantInvitationsRouter, { owner: 'tenant-invitations' });
    mountRouterSync(app, '/api/v1/admin/invitations', invitationAcceptRouter, { owner: 'invitation-accept' });

Suggestion: Correct the citation to `index.ts:1433`. No functional change needed.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
