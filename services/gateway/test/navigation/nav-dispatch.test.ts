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
import { NavCallContext, findRegistryScreenByRoute, navigateByRequest, openScreen } from '../../src/navigation/nav-dispatch';
import { buildContinuationDirective } from '../../src/navigation/nav-continuation';
import { isCascadeTool } from '../../src/orb/live/upstream/cascaded-live-client';
import { __setNavServiceForTests } from '../../src/navigation/nav-service';
import { createStaticNavEmbedder } from '../../src/navigation/nav-embedder';
import { buildLiveApiTools, NAVIGATE_TO_SCREEN_V2_DESCRIPTION } from '../../src/orb/live/tools/live-tool-catalog';
import { dispatchOrbTool } from '../../src/services/orb-tools-shared';
import { buildNavigatorPolicySection, handleNavigateToScreen, NAVIGATOR_POLICY_V2 } from '../../src/routes/orb-live';
import { handleNavResultMessage } from '../../src/navigation/nav-ack';
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
    for (const id of ['NOT.A_SCREEN', 'OVERLAY.MASTER_ACTION', 'COMM.GROUP_DETAIL']) {
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
    expect(JSON.parse(sse[0].replace(/^data: /, ''))).toMatchObject({ directive: 'navigate', screen_id: 'MEMORY.DIARY', after_speech: true });
    // VTID-04521/04520: no session-lifetime latch, and the route moves only
    // when the app confirms the screen opened.
    expect(session.navigationDispatched).toBeFalsy();
    expect(session.current_route).toBe('/home');
    expect(session.pendingNavAck).toMatchObject({ screen_id: 'MEMORY.DIARY' });
    handleNavResultMessage(session, { type: 'nav_result', screen_id: 'MEMORY.DIARY', route: '/memory/diary', status: 'opened', entry_kind: 'route' });
    expect(session.current_route).toBe('/memory/diary');
    expect(session.recent_routes[0]).toBe('/home');
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

describe('VTID-04521 — speak first, hold the offer, open on yes', () => {
  it('marks every registry directive to play out after the reply', async () => {
    expect(directive(await openScreen('INBOX.OVERVIEW', '', member))?.after_speech).toBe(true);
    expect(directive(await openScreen('LIFE_COMPASS.OVERLAY', '', member))?.after_speech).toBe(true);
  });

  it('holds a "where" answer as an offer, and never an "open" one', async () => {
    const recordOffer = jest.fn().mockResolvedValue(undefined);
    await navigateByRequest('Where can I write my daily diary?', 'where', { ...member, recordOffer });
    expect(recordOffer).toHaveBeenCalledWith(expect.objectContaining({ screen_id: 'MEMORY.DIARY', route: '/memory/diary' }));
    recordOffer.mockClear();
    await navigateByRequest('Open my messages', 'open', { ...member, recordOffer });
    expect(recordOffer).not.toHaveBeenCalled();
  });

  it('still answers when holding the offer fails', async () => {
    const recordOffer = jest.fn().mockRejectedValue(new Error('db down'));
    const r = await navigateByRequest('Where can I write my daily diary?', 'where', { ...member, recordOffer });
    expect(ok(r).result.offer.screen_id).toBe('MEMORY.DIARY');
  });

  it('maps an explain_feature route to its screen', () => {
    expect(findRegistryScreenByRoute('/memory/diary')?.id).toBe('MEMORY.DIARY');
    expect(findRegistryScreenByRoute('/inbox?tab=x')?.id).toBe('INBOX.OVERVIEW');
    expect(findRegistryScreenByRoute(null)).toBeNull();
  });

  it('opens an accepted offer through the gates, without the session latch', async () => {
    const session: any = { sessionId: 's1', lang: 'en', isAnonymous: false, current_route: '/home' };
    const built = await buildContinuationDirective(session, { screen_id: 'MEMORY.DIARY', route: '/memory/diary' });
    expect(built?.latch).toBe(false);
    expect(built?.directive).toMatchObject({ screen_id: 'MEMORY.DIARY', after_speech: true, reason: 'continuation_accept' });
    expect(session.pendingNavAck).toMatchObject({ screen_id: 'MEMORY.DIARY' });
  });

  it('opens nothing when the accepted screen is blocked or already showing', async () => {
    expect(await buildContinuationDirective({ current_route: '/home' } as any, { screen_id: 'OVERLAY.MASTER_ACTION', route: '/home' })).toBeNull();
    expect(await buildContinuationDirective({ current_route: '/wallet' } as any, { screen_id: 'WALLET.OVERVIEW', route: '/wallet' })).toBeNull();
    expect(await buildContinuationDirective({ current_route: '/home', isAnonymous: true } as any, { screen_id: 'WALLET.OVERVIEW', route: '/wallet' })).toBeNull();
  });

  it('keeps the legacy directive and latch with the flag off', async () => {
    delete process.env.NAV_V2_ENABLED;
    const built = await buildContinuationDirective({ current_route: '/home' } as any, { screen_id: 'MEMORY.DIARY', route: '/memory/diary', title: 'Diary' });
    expect(built).toEqual({ latch: true, directive: expect.objectContaining({ route: '/memory/diary', vtid: 'VTID-NAV-01' }) });
    expect(built?.directive.after_speech).toBeUndefined();
  });
});

describe('VTID-04521 — prompts and tool lists under the flag', () => {
  const decl = (name: string, surface?: string) => (buildLiveApiTools('authenticated', surface === 'admin' ? '/admin/users' : '/home', undefined, surface) as any[])
    .flatMap((t) => t.function_declarations || []).find((d: any) => d.name === name);

  it('describes navigate_to_screen without the "where is = redirect" lexicon', () => {
    const d = decl('navigate_to_screen')?.description as string;
    expect(d).toBe(NAVIGATE_TO_SCREEN_V2_DESCRIPTION);
    expect(d).not.toMatch(/HARD-REDIRECT|Locate/);
    delete process.env.NAV_V2_ENABLED;
    expect(decl('navigate_to_screen')?.description).toMatch(/HARD-REDIRECT/);
  });

  it('lets the admin surface open what navigate found', () => {
    expect(decl('navigate_to_screen', 'admin')).toBeDefined();
    delete process.env.NAV_V2_ENABLED;
    expect(decl('navigate_to_screen', 'admin')).toBeUndefined();
  });

  it('gives the cascade the three navigation tools', () => {
    for (const t of ['navigate', 'navigate_to_screen', 'get_current_screen']) expect(isCascadeTool(t)).toBe(true);
    expect(isCascadeTool('send_chat_message')).toBe(false);
    delete process.env.NAV_V2_ENABLED;
    expect(isCascadeTool('navigate')).toBe(false);
    expect(isCascadeTool('switch_persona')).toBe(true);
  });

  it('uses the V2 navigator policy, which describes the offer and speak-first', () => {
    const p = buildNavigatorPolicySection('de');
    expect(p).toBe(NAVIGATOR_POLICY_V2);
    expect(p).toMatch(/intent "where"/);
    expect(p).toMatch(/after you finish speaking/);
    delete process.env.NAV_V2_ENABLED;
    expect(buildNavigatorPolicySection('en')).not.toBe(NAVIGATOR_POLICY_V2);
  });

  it('never tells the model to call tools that do not exist', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/orb/live/instruction/live-system-instruction.ts'), 'utf8');
    expect(src).not.toMatch(/navigate_to\s*\(|navigate_to \/|get_route_for_path|get_route \//);
  });
});
