/**
 * notification-service.ts — getUserPrefs(), log-only fix.
 *
 * `fetchUserNotificationPreferences()` uses `.single()`, so PGRST116
 * ("no rows") is the normal "user has never set preferences" case.
 * `getUserPrefs()` destructured only `{ data }`, so a GENUINE query error
 * was indistinguishable from that normal case — both return `null`.
 * `notifyUser()` treats a null prefs result as "use permissive defaults"
 * (push_enabled defaults true, DND defaults not-in-window, see the
 * `prefs ? ... : true` / `prefs ? isInDndWindow(prefs) : false` branches),
 * so a real DB error at exactly the wrong moment could silently push-notify
 * a user who has actually opted out of push or is in a DND window.
 *
 * The fallback-to-permissive behavior is deliberately UNCHANGED here — no
 * live-traffic data on how often this path actually errors to justify
 * fail-closed (which would drop notifications more broadly on any blip);
 * only observability is added, matching this repo's established log-only
 * fix pattern (see admin-users.ts, role-admin.ts).
 *
 * Pinned at the source level — getUserPrefs is a module-internal,
 * non-exported function with no existing direct test harness, matching
 * this repo's own IntroExperience.orb-placement.test.ts precedent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '../../src/services/notification-service.ts'), 'utf8');

describe('notification-service.ts — getUserPrefs query error logging', () => {
  it('destructures `error` from fetchUserNotificationPreferences and logs a non-PGRST116 error', () => {
    const idx = SRC.indexOf('async function getUserPrefs(');
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 1000);

    expect(body).toContain('const { data, error } = await repo.fetchUserNotificationPreferences(supabase, userId, tenantId);');
    expect(body).toMatch(/if \(error && error\.code !== 'PGRST116'\) \{/);
    expect(body).toContain('console.warn(');
    // The permissive-fallback return value itself is unchanged
    expect(body).toContain('return data as UserPrefs | null;');
  });
});
