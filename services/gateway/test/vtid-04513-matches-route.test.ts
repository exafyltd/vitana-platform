/**
 * VTID-04513 — "open my matches" landed on the news feed.
 *
 * HOME.MATCHES routed to /home/matches, which the frontend redirects to /home
 * (the Longevity News feed, VTID-01900). Staging, 2026-09-24 16:08:44: the
 * navigator picked HOME.MATCHES and the member saw the news feed.
 */
import { NAVIGATION_CATALOG } from '../src/lib/navigation-catalog';

// Routes the frontend (exafyltd/vitana-v1 src/App.tsx) redirects to /home.
const REDIRECTS_TO_HOME = ['/home/matches', '/dashboard/matches'];

describe('VTID-04513 — the Matches screen opens the real matches page', () => {
  const entry = NAVIGATION_CATALOG.find((e) => e.screen_id === 'HOME.MATCHES');

  it('AC-1: HOME.MATCHES routes to /me/matches', () => {
    expect(entry?.route).toBe('/me/matches');
  });

  it('AC-2: no catalog entry about matches routes to a path that redirects to the news feed', () => {
    const bad = NAVIGATION_CATALOG.filter((e) => REDIRECTS_TO_HOME.includes(e.route));
    expect(bad.map((e) => e.screen_id)).toEqual([]);
  });
});
