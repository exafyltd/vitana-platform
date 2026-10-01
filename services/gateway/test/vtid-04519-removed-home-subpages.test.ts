/**
 * VTID-04519 — the removed Home sub-pages sent people to the news feed.
 *
 * VTID-01900 (vitana-v1) deleted the Home "Context", "Actions" and "AI feed"
 * pages; their routes redirect to /home, the Longevity News feed. The
 * navigator still listed HOME.CONTEXT / HOME.ACTIONS / HOME.AI_FEED, so
 * "show me my pending actions" opened the news feed. Their intents now land
 * on live screens.
 */
import { NAVIGATION_CATALOG, searchCatalog } from '../src/lib/navigation-catalog';

describe('VTID-04519 — no navigator entry for a removed Home sub-page', () => {
  it('AC-1: HOME.CONTEXT, HOME.ACTIONS and HOME.AI_FEED are gone from the code catalog', () => {
    const ids = NAVIGATION_CATALOG.map((e) => e.screen_id);
    expect(ids).not.toContain('HOME.CONTEXT');
    expect(ids).not.toContain('HOME.ACTIONS');
    expect(ids).not.toContain('HOME.AI_FEED');
  });

  it('AC-2: no entry routes to a path the frontend redirects to the news feed', () => {
    const dead = ['/home/context', '/home/actions', '/home/aifeed', '/home/matches', '/dashboard/matches'];
    expect(NAVIGATION_CATALOG.filter((e) => dead.includes(e.route)).map((e) => e.screen_id)).toEqual([]);
  });

  it.each([
    'show me my pending actions',
    'what tasks are pending for me',
  ])('AC-3: "%s" (community member) opens My Journey', (utterance) => {
    const r = searchCatalog(utterance, 'en', { role: 'community' });
    expect(r[0]?.entry.screen_id).toBe('AUTOPILOT.MY_JOURNEY');
  });
});
