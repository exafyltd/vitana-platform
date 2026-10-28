/**
 * lib/tenant-role-auth.ts — verifyAuth()'s me_context RPC, log-only fix.
 *
 * `meContextRpc()`/`me_context` was destructured as `{ data: meData }` only.
 * On a real RPC error, `meData` is undefined, so `tenant_id`/`active_role`
 * silently resolve to null for an otherwise-valid, authenticated caller.
 * `canManageRoles()` already fails CLOSED on both
 * (`active_role !== 'admin'` / `!tenant_id`) — a genuine tenant admin is
 * denied role-management with "Only admins can manage roles", misattributing
 * an infra failure to an access-control decision. That fail-closed
 * direction is deliberately UNCHANGED (not a security hole, exafy_admin
 * still bypasses it entirely) — only observability is added, matching this
 * repo's established log-only fix pattern (see admin-users.ts).
 *
 * VTID-03834 extracted verifyAuth() out of routes/role-admin.ts into this
 * shared lib file (for backoffice-access.ts to reuse) from a copy of
 * role-admin.ts that predated this fix, silently regressing it for BOTH
 * call sites at once. Re-applied here and re-pointed at the new location
 * during the VTID-03886 merge reconciliation.
 *
 * Pinned at the source level — this file has no existing test harness
 * (verifyAuth is a module-internal, non-exported function), matching this
 * repo's own IntroExperience.orb-placement.test.ts precedent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '../../src/lib/tenant-role-auth.ts'), 'utf8');

describe('lib/tenant-role-auth.ts — verifyAuth me_context RPC error logging', () => {
  it('destructures `error` from the me_context RPC and logs it before the unchanged fail-closed fallbacks', () => {
    const idx = SRC.indexOf("await userClient.rpc('me_context')");
    expect(idx).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, idx - 100), idx);
    expect(before).toMatch(/const \{ data: meData, error: meError \} = $/);

    const after = SRC.slice(idx, idx + 600);
    expect(after).toMatch(/if \(meError\) \{/);
    expect(after).toContain('console.warn(');
    // Fallback behavior itself is unchanged
    expect(after).toContain("const tenantId = meData?.tenant_id || null;");
    expect(after).toContain("const activeRole = meData?.active_role || null;");
  });
});
