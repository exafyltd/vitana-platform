/**
 * admin-users.ts — two unchecked `{data}`-only destructures, log-only fix.
 *
 * `verifyAdminAccess()`'s tenant-admin membership check and `GET /:userId`'s
 * tenant-membership scoping check both destructured only `{data}` from a
 * Supabase query. Both already fail CLOSED on a falsy result (403 FORBIDDEN
 * / 404 USER_NOT_FOUND respectively) — a real transient DB error and a
 * genuine "not authorized"/"not found" were indistinguishable, silently
 * misattributing an infra problem to an access-control decision. That
 * fail-closed direction is deliberately UNCHANGED here (this is not a
 * security hole) — only observability is added, matching this repo's
 * established log-only fix pattern for already-safe-direction findings
 * (see credit-recommender.ts).
 *
 * Pinned at the source level — this file has no existing route-test harness
 * (verifyAdminAccess is a module-internal, non-exported function), matching
 * this repo's own IntroExperience.orb-placement.test.ts precedent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '../../src/routes/admin-users.ts'), 'utf8');

describe('admin-users.ts — error logging on fail-closed auth checks', () => {
  it('verifyAdminAccess destructures `error` from fetchTenantAdminMembership and logs it before the fail-closed check', () => {
    const idx = SRC.indexOf('await repo.fetchTenantAdminMembership(');
    expect(idx).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, idx - 100), idx);
    expect(before).toMatch(/const \{ data: membership, error: membershipErr \} = $/);

    const after = SRC.slice(idx, idx + 550);
    expect(after).toMatch(/if \(membershipErr\) \{/);
    expect(after).toContain('console.warn(');
    // Fail-closed behavior itself is unchanged
    expect(after).toContain("if (!membership || membership.active_role !== 'admin')");
    expect(after).toContain("return { ok: false, status: 403, error: 'FORBIDDEN' };");
  });

  it('GET /:userId destructures `error` from fetchTenantMembershipCheck and logs it before the fail-closed check', () => {
    const idx = SRC.indexOf('await repo.fetchTenantMembershipCheck(');
    expect(idx).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, idx - 100), idx);
    expect(before).toMatch(/const \{ data: memberCheck, error: memberCheckErr \} = $/);

    const after = SRC.slice(idx, idx + 550);
    expect(after).toMatch(/if \(memberCheckErr\) \{/);
    expect(after).toContain('console.warn(');
    // Fail-closed behavior itself is unchanged
    expect(after).toContain('if (!memberCheck)');
    expect(after).toContain("return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });");
  });
});
