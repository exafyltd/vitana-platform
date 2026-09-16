/**
 * admin-notification-categories.ts — POST /:id/test's admin tenant_id
 * lookup, log-only fix.
 *
 * The lookup used `.single()` and destructured only `{data}`. On a genuine
 * DB error (not the routine PGRST116 "no rows" case an admin somehow
 * lacking a user_tenants row would hit) the test-send silently fell back to
 * a placeholder zero-UUID tenant instead of surfacing the failure. Low
 * impact — this is a diagnostic "send yourself a test notification" path,
 * not user-facing — so the fallback behavior is deliberately UNCHANGED;
 * only observability is added, matching this repo's established log-only
 * fix pattern for lower-severity findings (see credit-recommender.ts,
 * admin-users.ts).
 *
 * Pinned at the source level — this route has no existing test coverage
 * for the /:id/test handler (identity/notifyUser mocking would need a new
 * scaffold for a diagnostic-only path), matching this repo's own
 * IntroExperience.orb-placement.test.ts precedent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '../../src/routes/admin-notification-categories.ts'), 'utf8');

describe('admin-notification-categories.ts — POST /:id/test tenant_id lookup logging', () => {
  it('destructures `error` from the user_tenants lookup and logs a non-PGRST116 error before the unchanged fallback', () => {
    const idx = SRC.indexOf("const { data: tenantRow, error: tenantRowErr } = await supabase");
    expect(idx).toBeGreaterThan(-1);
    const after = SRC.slice(idx, idx + 500);

    expect(after).toContain(".from('user_tenants')");
    expect(after).toMatch(/if \(tenantRowErr && tenantRowErr\.code !== 'PGRST116'\) \{/);
    expect(after).toContain('console.warn(');
    // The fallback itself is unchanged
    expect(after).toContain("const tenantId = tenantRow?.tenant_id || '00000000-0000-0000-0000-000000000000';");
  });
});
