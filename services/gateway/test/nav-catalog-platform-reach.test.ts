/**
 * VTID-03614 — a desktop-only catalog row must still be reachable from a
 * mobile consult.
 *
 * The nav catalog carries one row per (screen_id, platform). Measured on
 * production: 187 distinct screens, of which 104 have both a mobile and a
 * desktop row, 47 are mobile-only, and **36 are desktop-only** — including
 * every Health plan tab, every Wallet balance/rewards tab, every Assistant
 * tab, every Services-Hub tab, Shop, Meine Tickets and Passende Mitglieder.
 *
 * `effectivePlatform()` hard-returns 'mobile' while NAV_PLATFORM_AWARE is
 * unset (it is unset in production and appears in no deploy workflow), so a
 * plain platform FILTER removed those 36 screens from the search space on
 * every consult, from every device.
 *
 * The symptom was not "not found". It was the Navigator confidently offering
 * the wrong neighbours and looping, because the right answer was never a
 * candidate at all.
 */
import { selectPlatformEntries } from '../src/lib/nav-catalog-db';

type E = { screen_id: string; platform?: string; note?: string };

const CATALOG: E[] = [
  { screen_id: 'HEALTH.OVERVIEW', platform: 'mobile', note: 'm' },
  { screen_id: 'HEALTH.OVERVIEW', platform: 'desktop', note: 'd' },
  { screen_id: 'COMM.FEED', platform: 'mobile', note: 'm' },
  // Desktop-only — the real-world shape of all 36 unreachable screens.
  { screen_id: 'HEALTH.PLANS_NUTRITION', platform: 'desktop', note: 'd' },
  { screen_id: 'WALLET.BALANCE_TOKENS', platform: 'desktop', note: 'd' },
  // No platform column at all — the compile-time NAVIGATION_CATALOG shape,
  // which has always counted as mobile.
  { screen_id: 'LEGACY.STATIC' },
];

const ids = (l: E[]) => l.map((e) => e.screen_id);

describe('VTID-03614 — cross-platform catalog reach', () => {
  test('a desktop-only screen IS reachable from a mobile consult', () => {
    const got = ids(selectPlatformEntries(CATALOG, 'mobile'));
    expect(got).toContain('HEALTH.PLANS_NUTRITION');
    expect(got).toContain('WALLET.BALANCE_TOKENS');
  });

  test('a mobile-only screen is reachable from a desktop consult', () => {
    expect(ids(selectPlatformEntries(CATALOG, 'desktop'))).toContain('COMM.FEED');
  });

  test('a screen present on both platforms appears exactly once', () => {
    for (const p of ['mobile', 'desktop'] as const) {
      const got = ids(selectPlatformEntries(CATALOG, p));
      expect(got.filter((s) => s === 'HEALTH.OVERVIEW')).toHaveLength(1);
    }
  });

  test('for a duplicated screen the REQUESTED platform row wins', () => {
    const m = selectPlatformEntries(CATALOG, 'mobile').find((e) => e.screen_id === 'HEALTH.OVERVIEW');
    const d = selectPlatformEntries(CATALOG, 'desktop').find((e) => e.screen_id === 'HEALTH.OVERVIEW');
    expect(m?.note).toBe('m');
    expect(d?.note).toBe('d');
  });

  test('an entry with no platform column still counts as mobile', () => {
    expect(ids(selectPlatformEntries(CATALOG, 'mobile'))).toContain('LEGACY.STATIC');
    // …and is still reachable from desktop, via the cross-platform pass.
    expect(ids(selectPlatformEntries(CATALOG, 'desktop'))).toContain('LEGACY.STATIC');
  });

  test('every screen in the catalog is reachable from every platform', () => {
    const all = new Set(CATALOG.map((e) => e.screen_id));
    for (const p of ['mobile', 'desktop'] as const) {
      expect(new Set(ids(selectPlatformEntries(CATALOG, p)))).toEqual(all);
    }
  });

  test('requested-platform entries lead, in their original order', () => {
    // Ordering matters: a newly-visible cross-platform entry must never
    // outrank, on a tie, something that already resolves today.
    const got = ids(selectPlatformEntries(CATALOG, 'mobile'));
    expect(got.slice(0, 3)).toEqual(['HEALTH.OVERVIEW', 'COMM.FEED', 'LEGACY.STATIC']);
    expect(got.slice(3).sort()).toEqual(['HEALTH.PLANS_NUTRITION', 'WALLET.BALANCE_TOKENS']);
  });

  test('an empty catalog stays empty (no crash, no phantom entries)', () => {
    expect(selectPlatformEntries([], 'mobile')).toEqual([]);
  });
});
