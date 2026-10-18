# Sparring round 1 — in_progress

Session: `643ff85b-f098-4544-ac74-55fda8d4644c` · plan hash `53ed8eac7bf1e46348455a191d8ba32dc6bbf5b4c3acdcf91188f6b1d1d72194`

## Summary

Three findings: one blocker (CI ownership guard not updated for Command Hub files) and two majors (exafy_admin cross-tenant view is silently broken by the stated mitigation; auth-model transition from requireExafyAdmin → requireTenantAdmin is unspecified for the routes being scoped). All verified against read files at the pinned commit.

## Findings

### R1-F1 [blocker]

The `command-hub-tenant-module` lane adds files to the CI-protected Command Hub path but the plan never mentions updating `command-hub-ownership-guard.js`. The CI guard will block the PR.

- `exafyltd/vitana-platform:scripts/ci/command-hub-ownership-guard.js:15` — const PROTECTED_PATH = 'services/gateway/src/frontend/command-hub/';
- `exafyltd/vitana-platform:scripts/ci/command-hub-ownership-guard.js:1051` — const ALLOWED_VTID_PATTERN = /VTID-05073|VTID-05153|...
- `exafyltd/vitana-platform:scripts/ci/command-hub-ownership-guard.js:1112` — function evaluateMarkerAuthorization(branchName, prTitle) {
    if (ALLOWED_VTID_PATTERN.test(branchName) || ALLOWED_VTID_PATTERN.test(prTitle)) {
      return { allowed: true, reason: 'allowlisted-marker' };
    }
    ...
    return { allowed: false, reason: 'no-authorized-marker' };
  }
- `exafyltd/vitana-platform:services/gateway/src/frontend/command-hub/modules.json:1` — { "bundle": [ ... { "file": "loops-catalog.js", "kind": "module" } ... ] }

Suggestion: The `command-hub-tenant-module` lane must include an edit to `scripts/ci/command-hub-ownership-guard.js` that appends the new VTID to `ALLOWED_VTID_PATTERN` (the same one-line pattern update every prior Command Hub VTID required, e.g., VTID-05084 added `loops-catalog.js` and `modules.json` by this mechanism). Because the VTID is not yet allocated (`xxxxx`), this must be a named TODO in the lane with the exact line to update once the VTID is assigned, and it must be in the same PR as the module files. Without it the CI guard calls `process.exit(1)` and the PR cannot merge.

### R1-F2 [major]

The plan's stated risk mitigation for the exafy_admin 'all-tenants' view is wrong. `requireTenantAdmin` never sets `req.targetTenantId` for exafy_admin (it returns at line 98 before reaching line 160). The fallback pattern cited as the mitigation — `targetTenantId || identity.tenant_id` — silently scopes exafy_admin to their own tenant, not all tenants. Routes such as `admin-signups.ts` currently serving cross-tenant data to exafy_admin will regress silently.

- `exafyltd/vitana-platform:services/gateway/src/middleware/require-tenant-admin.ts:95` — // Step 2: Exafy super-admin bypasses all tenant checks
    if (req.identity.exafy_admin) {
      next();
      return;
    }
- `exafyltd/vitana-platform:services/gateway/src/middleware/require-tenant-admin.ts:159` — // Attach the resolved target tenant for downstream handlers
    (req as any).targetTenantId = targetTenantId;
    next();
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-autopilot.ts:23` — function getTenantId(req: Request): string {
    return (req as any).targetTenantId || (req as AuthenticatedRequest).identity?.tenant_id;
  }
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:32` — router.get('/', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
    ...
    const { stage, tenant_id, search, ... } = req.query;
    ...
    tenantId: tenant_id && typeof tenant_id === 'string' ? tenant_id : undefined,

Suggestion: The plan must make an explicit choice for every scoped-read route: (a) if exafy_admin should still see cross-tenant data, the handler must branch on `req.identity.exafy_admin` and omit the tenant filter in that branch; (b) if exafy_admin is intentionally scoped to their own tenant via these routes, document that as a deliberate behaviour change (not a preserved capability). The claim that '`requireTenantAdmin` already supports both' is only true for the auth gate — it does not automatically deliver a cross-tenant data view. Every handler in the `tenant-admin-api` lane that calls `(req as any).targetTenantId || identity.tenant_id` will silently scope exafy_admin to their own tenant without a dedicated branch.

### R1-F3 [major]

The `tenant-admin-api` lane promises to tenant-scope 'moderation / signups / notifications / users / audit admin reads', but `admin-moderation.ts` uses its own inline `verifyExafyAdmin` (not `requireTenantAdmin`), and `admin-signups.ts` uses `requireExafyAdmin`. The plan does not specify whether the lane replaces those guards with `requireTenantAdmin` (which grants tenant-admin access to endpoints currently restricted to exafy_admin) or adds parallel new endpoints. Either choice has security consequences that must be stated explicitly.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-moderation.ts:1` — /**
 * Admin Content Moderation API — Moderation Reports
 * ...
 * Security:
 * - All endpoints require Bearer token + exafy_admin
 */
...
const VTID = 'ADMIN-MODERATION';
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-moderation.ts:50` — router.get('/reports', async (req: Request, res: Response) => {
    const auth = await verifyExafyAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    // No content_reports table exists yet — return empty array
    return res.json({ ok: true, reports: [] });
  });
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:19` — import { requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:32` — router.get('/', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {

Suggestion: For each route being tenant-scoped, the lane specification must name the auth guard change explicitly: either (i) 'add `requireTenantAdmin`; remove `requireExafyAdmin`/inline verifyExafyAdmin; exafy_admin retains access via the bypass, tenant-admin now also has access' (a deliberate widening that must be reviewed), or (ii) 'add a new tenant-scoped endpoint alongside the existing exafy_admin-only endpoint; existing endpoint untouched.' At minimum, the security model widening for admin-signups (currently exafy_admin-only; funnel data could reveal cross-tenant user counts/emails) must be owner-approved before implementation.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
