/**
 * VTID-04846 — with NAV_V2_ENABLED the screen registry answers every
 * navigation case on its own; nothing falls through to the legacy catalog.
 *
 *   - screens about one item (a member profile, a group, a match) open with
 *     the id a prior tool result handed the model, under the old argument
 *     names too, and never with a guessed one;
 *   - disabled panels stay closed even when an id is supplied;
 *   - "where am I" and the screen hints in the system instruction name the
 *     page from the registry, entity pages and unknown sub-pages included;
 *   - the admin area refuses voice navigation; other role areas use the
 *     member app's screens;
 *   - a resolver outage still opens a screen named exactly, and otherwise
 *     says so instead of guessing;
 *   - asking for the Audiobook or the full app on the way to My Journey
 *     switches that mode first.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  DEV_IDENTITY: { USER_ID: '00000000-0000-0000-0000-000000000099', TENANT_ID: '00000000-0000-0000-0000-000000000001' },
  isMemoryBridgeEnabled: () => false,
  isDevSandbox: () => false,
}));
jest.mock('../../src/services/guided-journey/guided-journey-state', () => ({
  setJourneyMode: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { setJourneyMode } from '../../src/services/guided-journey/guided-journey-state';
import {
  exactNameMatch,
  findScreenForRoute,
  isNavigationOffSurface,
  NavCallContext,
  navigateByRequest,
  openScreen,
} from '../../src/navigation/nav-dispatch';
import { __setNavServiceForTests } from '../../src/navigation/nav-service';
import { createStaticNavEmbedder } from '../../src/navigation/nav-embedder';
import { applyJourneyModeRequest, detectJourneyModeRequest, dispatchOrbTool } from '../../src/services/orb-tools-shared';
import { describeRoute } from '../../src/orb/live/instruction/live-system-instruction';
import { loadRegistryFixture } from '../nav-golden/registry-fixture';

const member: NavCallContext = { lang: 'en', isAnonymous: false, isMobile: false, currentRoute: '/home', sessionId: 's1' };
const identity = { user_id: 'u1', tenant_id: 't1', role: 'community', lang: 'en', session_id: 's1', is_anonymous: false, is_mobile: false };

type Ok = { ok: true; result: any; text: string };
const ok = (r: unknown) => r as Ok;
const directive = (r: unknown) => ok(r).result?.directive;
const errorOf = (r: unknown) => (r as { error?: string }).error || '';

beforeAll(async () => {
  const f = await loadRegistryFixture();
  __setNavServiceForTests({ index: f.index, embedder: f.embedder });
});
beforeEach(() => {
  (emitOasisEvent as jest.Mock).mockClear();
  (setJourneyMode as jest.Mock).mockClear();
});
afterAll(() => {
  delete process.env.NAV_GUIDED_JOURNEY;
});

describe('screens about one item open through the registry', () => {
  it('fills the route from the id a prior tool result supplied', async () => {
    const r = await dispatchOrbTool('navigate_to_screen', { screen_id: 'INBOX.CONVERSATION', recipient_id: 'user-42', current_route: '/home' }, identity as any);
    expect(directive(r)).toMatchObject({ screen_id: 'INBOX.CONVERSATION', route: '/inbox/u/user-42', entry_kind: 'route', vtid: 'VTID-04517' });
  });

  it.each([
    ['COMM.GROUP_DETAIL', { groupId: 'g-7' }, '/comm/groups/g-7'],
    ['INTENTS.MATCH_DETAIL', { match_id: 'm-3' }, '/intents/match/m-3'],
    ['PROFILE.PUBLIC', { vitana_id: '@maria' }, '/u/maria'],
    ['PROFILE.WITH_MATCH', { vitana_id: 'maria', intent_id: 'i-9' }, '/u/maria?match_intent=i-9'],
    ['NEWS.DETAIL', { id: 'n 1' }, '/news/n%201'],
  ])('%s accepts the tool schema argument names (%j)', async (screenId, args, route) => {
    const r = await dispatchOrbTool('navigate_to_screen', { screen_id: screenId, current_route: '/home', ...args }, identity as any);
    expect(directive(r)?.route).toBe(route);
  });

  it('never opens one without its id', async () => {
    const r = await dispatchOrbTool('navigate_to_screen', { screen_id: 'INBOX.CONVERSATION', current_route: '/home' }, identity as any);
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/recipient_id/);
    const blocked = (emitOasisEvent as jest.Mock).mock.calls.find((c) => c[0].type === 'orb.navigator.blocked')[0];
    expect(blocked.payload).toMatchObject({ error_kind: 'missing_param', resolver: 'registry-v2' });
  });

  it('keeps disabled panels closed even with an id', async () => {
    const r = await openScreen('OVERLAY.EVENT_DRAWER', '', member, { entityArgs: { event_id: 'e1' } });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/cannot be opened by voice/);
  });

  it('keeps the member gate for entity screens', async () => {
    const r = await openScreen('INBOX.CONVERSATION', '', { ...member, isAnonymous: true }, { entityArgs: { recipient_id: 'x' } });
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/not signed in/);
  });

  it('says "already there" when the member is on that very item', async () => {
    const r = await openScreen('INBOX.CONVERSATION', '', { ...member, currentRoute: '/inbox/u/user-42' }, { entityArgs: { recipient_id: 'user-42' } });
    expect(ok(r).result.already_there).toBe(true);
  });

  it('no longer reads the legacy catalog for any of this', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/services/orb-tools-shared.ts'), 'utf8');
    const v2Block = src.slice(src.indexOf('export async function tool_navigate_to_screen('), src.indexOf("const { emitOasisEvent } = await import('./oasis-event-service');\n\n  // Three-tier resolution"));
    expect(v2Block).toMatch(/return nav\.navigateByRequest\(query, 'open'/);
    expect(v2Block).not.toMatch(/needsEntity|isLegacySurface/);
  });
});

describe('where am I — the registry names the page', () => {
  it.each([
    ['/inbox', 'INBOX.OVERVIEW'],
    ['/u/maria', 'PROFILE.PUBLIC'],
    ['/comm/groups/g-7', 'COMM.GROUP_DETAIL'],
    ['/comm/events-meetups/some/deeper/page', 'COMM.EVENTS'],
    ['/command-hub/overview', null],
  ])('%s → %s', (route, expected) => {
    const s = findScreenForRoute(route, route.startsWith('/command-hub') ? 'command-hub' : 'community');
    if (expected === null) expect(s?.surface).toBe('command-hub');
    else expect(s?.id).toBe(expected);
  });

  it('get_current_screen answers from the registry, in the member language', async () => {
    const r = await dispatchOrbTool('get_current_screen', { current_route: '/inbox', recent_routes: ['/inbox', '/u/maria', '/home'] }, { ...identity, lang: 'de' } as any);
    expect(ok(r).result).toMatchObject({ screen_id: 'INBOX.OVERVIEW', route: '/inbox' });
    expect(ok(r).result.recent_screens.length).toBe(2);
    expect(ok(r).result.title).not.toBe('Unknown screen');
  });

  it('get_current_screen reports a page the registry does not describe as unknown', async () => {
    const r = await dispatchOrbTool('get_current_screen', { current_route: '/zzz-not-a-page' }, identity as any);
    expect(ok(r).result.title).toBe('Unknown screen');
  });

  it('the system instruction screen hint uses the registry title', () => {
    expect(describeRoute('/u/maria', 'en')).toEqual({ title: expect.any(String), path: '/u/maria' });
    expect(describeRoute('/u/maria', 'en')?.title).not.toBe('/u/maria');
    expect(describeRoute('/zzz-not-a-page', 'en')).toEqual({ title: '/zzz-not-a-page', path: '/zzz-not-a-page' });
  });
});

describe('role areas', () => {
  it('only the admin area is off', () => {
    expect(isNavigationOffSurface('/admin')).toBe(true);
    expect(isNavigationOffSurface('/admin/users')).toBe(true);
    expect(isNavigationOffSurface('/administrator')).toBe(false);
    expect(isNavigationOffSurface('/backoffice')).toBe(false);
    expect(isNavigationOffSurface('/home')).toBe(false);
  });

  it('navigate_to_screen refuses in the admin area', async () => {
    const r = await dispatchOrbTool('navigate_to_screen', { screen_id: 'INBOX.OVERVIEW', current_route: '/admin/users' }, identity as any);
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/admin area/);
  });
});

describe('a resolver outage', () => {
  const outage = async <T>(fn: () => Promise<T>): Promise<T> => {
    const f = await loadRegistryFixture();
    __setNavServiceForTests({ index: f.index, embedder: createStaticNavEmbedder(new Map([['x', new Float32Array(512)]])) });
    try {
      return await fn();
    } finally {
      __setNavServiceForTests({ index: f.index, embedder: f.embedder });
    }
  };

  it('still opens a screen named exactly', async () => {
    const r = await outage(() => navigateByRequest('inbox', 'open', member));
    expect(directive(r)?.screen_id).toBe('INBOX.OVERVIEW');
  });

  it('matches names, never fragments', () => {
    const ctx = { lang: 'en', authenticated: true, surface: 'community' as const };
    expect(exactNameMatch('inbox', ctx)?.id).toBe('INBOX.OVERVIEW');
    expect(exactNameMatch('take me somewhere with my inbox and more', ctx)).toBeNull();
    expect(exactNameMatch('in', ctx)).toBeNull();
  });

  it('answers honestly otherwise', async () => {
    const r = await outage(() => navigateByRequest('the thing with the colourful charts', 'open', member));
    expect(ok(r).result.decision).toBe('unavailable');
    expect(directive(r)).toBeUndefined();
  });
});

describe('My Journey mode on the way there (NAV_GUIDED_JOURNEY)', () => {
  it.each([
    ['open my journey as an audiobook', 'guided'],
    ['zeig mir die Vollversion meiner Reise', 'full'],
    ['the full app, not the guided journey', 'full'],
    ['open my journey', null],
  ])('%s → %s', (text, mode) => {
    expect(detectJourneyModeRequest(text)).toBe(mode);
  });

  it('switches the mode before opening My Journey', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    const opened = await openScreen('AUTOPILOT.MY_JOURNEY', '', member);
    const r = await applyJourneyModeRequest(opened, 'open my journey as an audiobook', identity as any, {} as any);
    expect(setJourneyMode).toHaveBeenCalledWith({}, 'u1', 'guided');
    expect(ok(r).text).toMatch(/MODE_SWITCH/);
  });

  it('leaves every other screen alone', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    const opened = await openScreen('INBOX.OVERVIEW', '', member);
    const r = await applyJourneyModeRequest(opened, 'the audiobook please', identity as any, {} as any);
    expect(setJourneyMode).not.toHaveBeenCalled();
    expect(r).toBe(opened);
  });
});
