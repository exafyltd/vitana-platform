/**
 * role-admin.ts — verifyAuth()'s me_context RPC, log-only fix.
 *
 * `meContextRpc()` was destructured as `{ data: meData }` only. On a real
 * RPC error, `meData` is undefined, so `tenant_id`/`active_role` silently
 * resolve to null for an otherwise-valid, authenticated caller.
 * `canManageRoles()` already fails CLOSED on both
 * (`active_role !== 'admin'` / `!tenant_id`) — a genuine tenant admin is
 * denied role-management with "Only admins can manage roles", misattributing
 * an infra failure to an access-control decision. That fail-closed
 * direction is deliberately UNCHANGED (not a security hole, exafy_admin
 * still bypasses it entirely) — only observability is added, matching this
 * repo's established log-only fix pattern (see admin-users.ts).
 *
 * Pinned at the source level — this file has no existing test harness
 * (verifyAuth is a module-internal, non-exported function), matching this
 * repo's own IntroExperience.orb-placement.test.ts precedent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '../../src/routes/role-admin.ts'), 'utf8');

describe('role-admin.ts — verifyAuth me_context RPC error logging', () => {
  it('destructures `error` from meContextRpc and logs it before the unchanged fail-closed fallbacks', () => {
    const idx = SRC.indexOf('await repo.meContextRpc(userClient)');
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
