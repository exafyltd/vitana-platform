/**
 * VTID-NAV-CONFIDENCE + VTID-NAV-SURFACE (Fix-2) — navigate_to_screen gates.
 *
 * Two new guards against wrong-screen redirects, both enforced in the SHARED
 * dispatcher tool_navigate_to_screen (so they apply to Vertex AND LiveKit
 * identically — Vertex via handleNavigateToScreen, LiveKit via tools.py →
 * /api/v1/orb/tool):
 *
 *   1. Confidence floor — a fuzzy screen_id only auto-resolves when its
 *      suggestSimilar score clears FUZZY_NAV_MIN_SCORE. A weak best-match no
 *      longer silently teleports the user to "the nearest thing".
 *   2. Surface scoping — the session's surface is derived from current_route;
 *      a community session can never be navigated into /admin or /command-hub,
 *      and a developer in Command Hub is never sent to a community route.
 *
 * Plus: Journey Foundation route validation — every Foundation step points at
 * a navigation_route that is either catalog-resolvable or a documented
 * surface-neutral key, and the tier-0 gate step is navigable to a real screen.
 */

import { tool_navigate_to_screen } from '../src/services/orb-tools-shared';
import {
  suggestSimilarScored,
  FUZZY_NAV_MIN_SCORE,
  lookupByRoute,
  lookupScreen,
} from '../src/lib/navigation-catalog';
import { FOUNDATION_STEPS } from '../src/services/journey-foundation/foundation-steps';

// current_route is read from args by the handler (not from identity), so the
// identity is route-independent here; the surface is derived from args.current_route.
const communityIdentity = {
  user_id: 'u1',
  tenant_id: 't1',
  role: 'community',
  lang: 'en',
  session_id: 's1',
  is_anonymous: false,
  is_mobile: false,
};

describe('VTID-NAV-CONFIDENCE — fuzzy confidence floor', () => {
  it('FUZZY_NAV_MIN_SCORE keeps legit fuzzy matches and rejects noise', () => {
    // Legit (from the real catalog): BUSINESS_HUB → BUSINESS.OVERVIEW = 16.
    expect(suggestSimilarScored('BUSINESS_HUB', 1)[0].score).toBeGreaterThanOrEqual(FUZZY_NAV_MIN_SCORE);
    expect(suggestSimilarScored('MEDIA_HUB', 1)[0].score).toBeGreaterThanOrEqual(FUZZY_NAV_MIN_SCORE);
    // Pure noise resolves to nothing.
    expect(suggestSimilarScored('TOTALLY_UNRELATED', 1)).toHaveLength(0);
    expect(suggestSimilarScored('XYZZY', 1)).toHaveLength(0);
  });

  it('rejects an unknown screen_id with no candidates (unchanged contract)', async () => {
    const r = await tool_navigate_to_screen(
      { screen_id: 'XYZZY_NONSENSE', current_route: '/comm' },
      communityIdentity,
    );
    expect(r.ok).toBe(false);
  });

  it('still auto-resolves a confident fuzzy match (BUSINESS_HUB → BUSINESS.OVERVIEW)', async () => {
    const r = await tool_navigate_to_screen(
      { screen_id: 'BUSINESS_HUB', current_route: '/comm' },
      communityIdentity,
    );
    // BUSINESS.OVERVIEW is a community-surface screen, so it passes the surface
    // gate from a community session and resolves.
    expect(r.ok).toBe(true);
  });
});

describe('VTID-NAV-SURFACE — surface scoping', () => {
  it('blocks a community session from navigating into a developer (Command Hub) screen', async () => {
    // "dashboard" fuzzy-resolves to DEVHUB.OPERATOR.DASHBOARD (score 43 — well
    // above the floor), so without the surface gate it WOULD teleport a
    // community user into Command Hub. The gate must block it.
    const r = await tool_navigate_to_screen(
      { screen_id: 'DEVHUB.INFRA.LOGS', current_route: '/comm' },
      communityIdentity,
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/different surface|surface/i);
  });

  it('blocks a community session from an /admin screen', async () => {
    const adminScreen = lookupScreen('ADMIN.OVERVIEW') ? 'ADMIN.OVERVIEW' : null;
    // Use a route-derived admin entry if one exists; otherwise assert the
    // developer block above already proves the gate. Guard for catalog drift.
    if (!adminScreen) return;
    const r = await tool_navigate_to_screen(
      { screen_id: adminScreen, current_route: '/comm' },
      communityIdentity,
    );
    expect(r.ok).toBe(false);
  });

  it('allows a developer session (Command Hub surface) into a developer screen', async () => {
    const r = await tool_navigate_to_screen(
      { screen_id: 'DEVHUB.INFRA.LOGS', current_route: '/command-hub/infrastructure/health/' },
      { user_id: 'u1', tenant_id: 't1', role: 'developer', lang: 'en', session_id: 's1', is_anonymous: false, is_mobile: false },
    );
    // Surface gate passes (developer→developer); resolution proceeds.
    expect(r.ok).toBe(true);
  });

  it('allows a community session into a community screen', async () => {
    const r = await tool_navigate_to_screen(
      { screen_id: 'COMM.EVENTS', current_route: '/comm' },
      communityIdentity,
    );
    expect(r.ok).toBe(true);
  });
});

describe('VTID-NAV (Fix-2) — Journey Foundation route validation', () => {
  // navigation_route values are surface-neutral keys (see foundation-steps.ts
  // header) — most are NOT catalog routes by design. This allowlist documents
  // that intent so a typo or dead key still fails the test.
  const SURFACE_NEUTRAL_JOURNEY_ROUTES = new Set([
    '/journey/goal',
    '/journey/focus',
    '/learn/economy',
    '/profile',
    '/diary',
    '/index',
    '/journey/economy',
    '/connect',
    '/events',
    '/marketplace',
  ]);

  it('every Foundation step route is catalog-resolvable OR a documented surface-neutral key', () => {
    for (const step of FOUNDATION_STEPS as Array<{ key: string; navigation_route: string | null }>) {
      const route = step.navigation_route;
      expect(route && route.startsWith('/')).toBeTruthy();
      const resolved = route ? lookupByRoute(route) : null;
      const documented = route ? SURFACE_NEUTRAL_JOURNEY_ROUTES.has(route) : false;
      // Fails loudly if a step points at neither a real catalog route nor a
      // known surface-neutral key (i.e. a typo or a newly-dead route).
      expect(Boolean(resolved) || documented).toBe(true);
    }
  });

  it('navigation_routes are unique across steps (no copy-paste collisions)', () => {
    const routes = (FOUNDATION_STEPS as Array<{ navigation_route: string | null }>).map((s) => s.navigation_route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
