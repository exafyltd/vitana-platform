/**
 * VTID-04519 — the removed Home sub-pages sent people to the news feed.
 *
 * VTID-01900 (vitana-v1) deleted the Home "Context", "Actions" and "AI feed"
 * pages; their routes redirect to /home, the Longevity News feed. The
 * navigator still listed HOME.CONTEXT / HOME.ACTIONS / HOME.AI_FEED, so
 * "show me my pending actions" opened the news feed.
 *
 * VTID-04846: the legacy catalog is gone; the same guarantees now hold for the
 * screen registry Vitana navigates from.
 */
import { getNavRegistry } from '../src/navigation/nav-registry';

describe('VTID-04519 — no navigator screen for a removed Home sub-page', () => {
  const screens = getNavRegistry().registry.screens;

  it('AC-1: HOME.CONTEXT, HOME.ACTIONS and HOME.AI_FEED are not registry screens', () => {
    const ids = screens.map((s) => s.id);
    expect(ids).not.toContain('HOME.CONTEXT');
    expect(ids).not.toContain('HOME.ACTIONS');
    expect(ids).not.toContain('HOME.AI_FEED');
  });

  it('AC-2: no screen routes to a path the frontend redirects to the news feed', () => {
    const dead = ['/home/context', '/home/actions', '/home/aifeed', '/home/matches', '/dashboard/matches'];
    expect(screens.filter((s) => dead.includes(s.route.split('?')[0])).map((s) => s.id)).toEqual([]);
  });
});
