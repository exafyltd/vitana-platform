/**
 * VTID-04517 — the navigation dispatcher behind NAV_V2_ENABLED, driven the
 * way a voice session drives it: the real registry snapshot, its stored
 * vectors, the shared tool entry points and orb-live's navigate_to_screen
 * handler.
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

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { NavCallContext, navigateByRequest, openScreen } from '../../src/navigation/nav-dispatch';
import { __setNavServiceForTests } from '../../src/navigation/nav-service';
import { createStaticNavEmbedder } from '../../src/navigation/nav-embedder';
import { buildLiveApiTools } from '../../src/orb/live/tools/live-tool-catalog';
import { dispatchOrbTool } from '../../src/services/orb-tools-shared';
import { handleNavigateToScreen } from '../../src/routes/orb-live';
import { loadRegistryFixture } from '../nav-golden/registry-fixture';

const member: NavCallContext = { lang: 'en', isAnonymous: false, isMobile: false, currentRoute: '/home', sessionId: 's1' };
const identity = { user_id: 'u1', tenant_id: 't1', role: 'community', lang: 'en', session_id: 's1', is_anonymous: false, is_mobile: false };

type Ok = { ok: true; result: any; text: string };
const ok = (r: unknown) => r as Ok;
const directive = (r: unknown) => ok(r).result?.directive;

beforeAll(async () => {
  const f = await loadRegistryFixture();
  __setNavServiceForTests({ index: f.index, embedder: f.embedder });
});
beforeEach(() => {
  process.env.NAV_V2_ENABLED = 'true';
  (emitOasisEvent as jest.Mock).mockClear();
});
afterAll(() => {
  delete process.env.NAV_V2_ENABLED;
});

describe('openScreen — every gate in one place', () => {
  it('opens a registry screen with the payload the web client handles', async () => {
    const r = await openScreen('INBOX.OVERVIEW', 'open my messages', member);
    expect(directive(r)).toMatchObject({ type: 'orb_directive', directive: 'navigate', screen_id: 'INBOX.OVERVIEW', entry_kind: 'route' });
    expect(ok(r).result.route).toBe('/inbox');
  });

  it('accepts ids retired when Phase 1 merged screens', async () => {
    expect(directive(await openScreen('MESSAGES.OVERVIEW', '', member))?.screen_id).toBe('INBOX.OVERVIEW');
  });

  it('uses the mobile route on a mobile session', async () => {
    const r = await openScreen('MEMORY.DIARY', '', { ...member, isMobile: true });
    expect(directive(r)?.route).toBe('/daily-diary?tab=health');
  });

  it('opens overlays through their ?open= marker', async () => {
    const r = await openScreen('LIFE_COMPASS.OVERLAY', '', member);
    expect(directive(r)).toMatchObject({ entry_kind: 'overlay', route: '/home?open=life_compass' });
  });

  it('refuses unknown, disabled and entity-only screens without guessing', async () => {
    for (const id of ['NOT.A_SCREEN', 'OVERLAY.WALLET_POPUP', 'COMM.GROUP_DETAIL']) {
      const r = await openScreen(id, '', member);
      expect(r.ok).toBe(false);
    }
  });

  it('keeps member screens away from anonymous visitors but opens public ones', async () => {
    expect((await openScreen('WALLET.OVERVIEW', '', { ...member, isAnonymous: true })).ok).toBe(false);
    expect(directive(await openScreen('PUBLIC.TERMS', '', { ...member, isAnonymous: true }))?.screen_id).toBe('PUBLIC.TERMS');
  });

  it('says so when the member is already there, instead of reloading the page', async () => {
    const r = await openScreen('WALLET.OVERVIEW', '', { ...member, currentRoute: '/wallet' });
    expect(ok(r).result.already_there).toBe(true);
    expect(directive(r)).toBeUndefined();
  });
});

describe('navigate — open vs. where', () => {
  it('opens right away on an explicit open request', async () => {
    const r = await navigateByRequest('Open my messages', 'open', member);
    expect(directive(r)?.screen_id).toBe('INBOX.OVERVIEW');
  });

  it('answers a where-question with an offer and moves nothing', async () => {
    const r = await navigateByRequest('Where can I write my daily diary?', 'where', member);
    expect(directive(r)).toBeUndefined();
    expect(ok(r).result.offer.screen_id).toBe('MEMORY.DIARY');
    expect(ok(r).text).toContain('navigate_to_screen');
  });

  it('hands near-ties to the model as candidates', async () => {
    const r = await navigateByRequest('Where can I see my Vitana Index score?', 'open', member);
    expect(directive(r)).toBeUndefined();
    expect(ok(r).result.candidates.map((c: any) => c.screen_id)).toEqual(expect.arrayContaining(['HEALTH.VITANA_INDEX']));
  });

  it('never navigates on small talk', async () => {
    for (const q of ['How are you today?', 'Tell me a joke', 'Wie geht es dir?']) {
      const r = await navigateByRequest(q, 'open', { ...member, lang: q.startsWith('Wie') ? 'de' : 'en' });
      expect(directive(r)).toBeUndefined();
    }
  });

  it('records what it decided', async () => {
    await navigateByRequest('Open my messages', 'open', member);
    const types = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0].type);
    expect(types).toEqual(expect.arrayContaining(['orb.navigator.resolved', 'orb.navigator.requested']));
    const resolved = (emitOasisEvent as jest.Mock).mock.calls.find((c) => c[0].type === 'orb.navigator.resolved')[0];
    expect(resolved.payload).toMatchObject({ resolver: 'registry-v2', kind: 'match', intent: 'open' });
  });

  it('returns null so the caller falls back when the resolver cannot run', async () => {
    const f = await loadRegistryFixture();
    __setNavServiceForTests({ index: f.index, embedder: createStaticNavEmbedder(new Map([['x', new Float32Array(512)]])) });
    try {
      expect(await navigateByRequest('something never embedded', 'open', member)).toBeNull();
    } finally {
      __setNavServiceForTests({ index: f.index, embedder: f.embedder });
    }
  });
});

describe('the shared voice tools with NAV_V2_ENABLED', () => {
  it('navigate goes through the registry resolver', async () => {
    const r = await dispatchOrbTool('navigate', { question: 'Where can I see my appointments?', intent: 'where', current_route: '/home' }, identity as any);
    expect(ok(r).result.offer.screen_id).toBe('CALENDAR.OVERVIEW');
  });

  it('navigate defaults to "where" when the model leaves intent out — nothing moves', async () => {
    const r = await dispatchOrbTool('navigate', { question: 'Open my messages', current_route: '/home' }, identity as any);
    expect(directive(r)).toBeUndefined();
    expect(ok(r).result.offer.screen_id).toBe('INBOX.OVERVIEW');
  });

  it('keeps role surfaces on the legacy navigator', async () => {
    const r = await dispatchOrbTool('navigate', { question: 'Open my messages', intent: 'open', current_route: '/admin/users' }, identity as any);
    expect((ok(r).result as any)?.offer).toBeUndefined();
    const types = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0].type);
    expect(types).not.toContain('orb.navigator.resolved');
  });

  it('navigate_to_screen resolves an invented id from the stated reason instead of fuzzy-matching it', async () => {
    const r = await dispatchOrbTool('navigate_to_screen', { screen_id: 'MESSAGES.MY_INBOX_PAGE', reason: 'Open my messages' }, identity as any);
    expect(directive(r)?.screen_id).toBe('INBOX.OVERVIEW');
  });
});

describe('the "where → offer → yes → open" conversation through orb-live', () => {
  it('opens the offered screen when the model confirms with its screen_id', async () => {
    const offer = await dispatchOrbTool('navigate', { question: 'Where can I write my daily diary?', intent: 'where', current_route: '/home' }, identity as any);
    const offered = ok(offer).result.offer.screen_id;
    const session: any = {
      sessionId: 's1', lang: 'en', isAnonymous: false,
      identity: { user_id: 'u1', tenant_id: 't1', role: 'community' }, active_role: 'community',
      current_route: '/home', recent_routes: ['/home'], turn_count: 2, inputTranscriptBuffer: '',
    };
    const sse: string[] = [];
    session.sseResponse = { write: (s: string) => sse.push(s) };
    const r = await handleNavigateToScreen(session, { screen_id: offered, reason: 'member said yes' });
    expect(r.success).toBe(true);
    expect(sse).toHaveLength(1);
    expect(JSON.parse(sse[0].replace(/^data: /, ''))).toMatchObject({ directive: 'navigate', screen_id: 'MEMORY.DIARY' });
    expect(session.current_route).toBe('/memory/diary');
  });
});

describe('tool declarations', () => {
  const navigateDecl = () => (buildLiveApiTools('authenticated', '/home') as any[])
    .flatMap((t) => t.function_declarations || [t]).find((d: any) => d.name === 'navigate');

  it('declares navigate with an open/where intent when the flag is on', () => {
    expect(navigateDecl()?.parameters?.properties?.intent?.enum).toEqual(['open', 'where']);
  });

  it('leaves the declaration unchanged when the flag is off', () => {
    delete process.env.NAV_V2_ENABLED;
    const decl = navigateDecl();
    expect(decl?.parameters?.properties?.question).toBeDefined();
    expect(decl?.parameters?.properties?.intent).toBeUndefined();
  });
});
