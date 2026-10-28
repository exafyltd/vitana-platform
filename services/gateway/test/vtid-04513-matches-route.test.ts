/**
 * VTID-04513 — "open my matches" landed on the news feed.
 *
 * HOME.MATCHES routed to /home/matches, which the frontend redirects to /home
 * (the Longevity News feed, VTID-01900). Staging, 2026-09-24 16:08:44: the
 * navigator picked HOME.MATCHES and the member saw the news feed.
 *
 * VTID-04846: the legacy catalog is gone; the same guarantees now hold for the
 * screen registry Vitana navigates from.
 */
import { getNavRegistry } from '../src/navigation/nav-registry';
import { findRegistryScreen } from '../src/navigation/nav-dispatch';

// Routes the frontend (exafyltd/vitana-v1 src/App.tsx) redirects to /home.
const REDIRECTS_TO_HOME = ['/home/matches', '/dashboard/matches'];

describe('VTID-04513 — the Matches screen opens the real matches page', () => {
  it('AC-1: the matches screen routes to /me/matches', () => {
    const s = findRegistryScreen('HOME.MATCHES') || findRegistryScreen('matches');
    expect(s?.route.split('?')[0]).toBe('/me/matches');
  });

  it('AC-2: no registry screen routes to a path that redirects to the news feed', () => {
    const bad = getNavRegistry().registry.screens.filter((s) => REDIRECTS_TO_HOME.includes(s.route.split('?')[0]));
    expect(bad.map((s) => s.id)).toEqual([]);
  });
});
