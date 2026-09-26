/**
 * VTID-04644 — when the member plainly asks to open a screen and the voice
 * model answers without opening anything, the gateway opens the one screen
 * that clearly fits. Runs on the bundled registry snapshot and its stored
 * Titan vectors (no network), over every case of the redirect suite.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import * as fs from 'fs';
import * as path from 'path';
import { __setNavServiceForTests } from '../../src/navigation/nav-service';
import {
  detectExplicitOpenRequest,
  maybeRunExplicitOpenBackstop,
} from '../../src/orb/live/session/explicit-open-backstop';
import { loadRegistryFixture } from '../nav-golden/registry-fixture';
import { REDIRECT_CASES } from './redirect-cases';
import { directiveProblems, REDIRECT_CURRENT_ROUTE } from './redirect-harness';

function fakeSession(over: Record<string, unknown> = {}) {
  const sent: Record<string, any>[] = [];
  const session: Record<string, any> = {
    sessionId: 'test-session',
    active: true,
    lang: 'en',
    isAnonymous: false,
    is_mobile: false,
    current_route: REDIRECT_CURRENT_ROUTE,
    turn_count: 3,
    sseResponse: { write: (chunk: string) => sent.push(JSON.parse(chunk.replace(/^data: /, '').trim())) },
    ...over,
  };
  return { session, sent };
}

const deps = { emitDiag: jest.fn(), sendWsMessage: jest.fn() };

describe('VTID-04644 explicit open request — detection', () => {
  it.each([
    ['en', 'Show me the screen where I can make a post'],
    ['en', 'open my wallet'],
    ['en', 'Can you take me to the settings?'],
    ['en', 'please pull up my calendar'],
    ['de', 'Zeig mir, wo ich einen Post machen kann'],
    ['de', 'Öffne den Newsfeed'],
    ['de', 'Bring mich zu den Einstellungen'],
    ['de', 'mach mal den Kalender auf'],
    ['es', 'Ábreme la billetera'],
    ['es', 'Muéstrame mis mensajes'],
    ['fr', 'Ouvre mes paramètres'],
    ['fr', 'Montre-moi le calendrier'],
    ['sr', 'Otvori podešavanja'],
    ['pt', 'Abra a minha carteira'],
    ['pl', 'Otwórz ustawienia'],
    ['ru', 'Открой настройки'],
    ['tr', 'Ayarları aç'],
    ['ar', 'افتح الإعدادات'],
    ['zh', '打开设置'],
  ])('%s "%s" is an open request', (_lang, text) => {
    expect(detectExplicitOpenRequest(text)).toBe(true);
  });

  it.each([
    'Where can I make a post for the community?',
    'How can I share a post with the community?',
    'Wo kann ich einen Beitrag für die Community machen?',
    "Don't open it, just tell me",
    'Please do not open the wallet',
    "I'm open to suggestions",
    'The shop is open until six',
    'Öffne das bitte nicht',
    'Zeig mir das jetzt nicht',
    'No abras la billetera',
    "N'ouvre pas ça",
    'Nemoj otvoriti',
    'ja mach das',
    'What is my Vitana Index?',
    '',
  ])('"%s" is not an open request', (text) => {
    expect(detectExplicitOpenRequest(text)).toBe(false);
  });
});

describe('VTID-04644 explicit open backstop — through the registry', () => {
  beforeAll(async () => {
    process.env.NAV_V2_ENABLED = 'true';
    const f = await loadRegistryFixture();
    __setNavServiceForTests({ index: f.index, embedder: f.embedder });
  });

  afterAll(() => {
    delete process.env.NAV_V2_ENABLED;
    delete process.env.ORB_NAV_OPEN_BACKSTOP_ENABLED;
  });

  beforeEach(() => {
    delete process.env.ORB_NAV_OPEN_BACKSTOP_ENABLED;
    deps.emitDiag.mockClear();
    deps.sendWsMessage.mockClear();
  });

  it('the production request ("show me the screen where I can make a post") opens the post composer', async () => {
    const { session, sent } = fakeSession({ current_route: '/comm/events-meetups' });
    const opened = await maybeRunExplicitOpenBackstop(deps, session, 'Show me the screen where I can make a post', false);
    expect(opened).toBe('HOME.CREATE_POST');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'orb_directive', directive: 'navigate', screen_id: 'HOME.CREATE_POST', after_speech: true, after_turn: true });
    expect(String(sent[0].route)).toContain('compose=1');
    expect(session.pendingNavAck).toMatchObject({ screen_id: 'HOME.CREATE_POST' });
    expect(session.navigationDispatchedTurn).toBe(3);
  });

  it('the same in German opens the post composer', async () => {
    const { session, sent } = fakeSession({ lang: 'de', current_route: '/comm/events-meetups' });
    expect(await maybeRunExplicitOpenBackstop(deps, session, 'Zeig mir, wo ich einen Post machen kann', false)).toBe('HOME.CREATE_POST');
    expect(sent[0]?.screen_id).toBe('HOME.CREATE_POST');
  });

  it('never opens a wrong screen, over every case of the redirect suite', async () => {
    const opened: string[] = [];
    const wrong: string[] = [];
    for (const c of REDIRECT_CASES) {
      const viewport = c.viewport ?? 'desktop';
      const { session, sent } = fakeSession({ lang: c.lang, is_mobile: viewport === 'mobile', current_route: c.from ?? REDIRECT_CURRENT_ROUTE });
      const run = maybeRunExplicitOpenBackstop(deps, session, c.say, false);
      if (!detectExplicitOpenRequest(c.say)) {
        expect(run).toBeNull();
        continue;
      }
      const id = await run;
      if (!id) continue;
      opened.push(c.id);
      if (!c.expect.includes(id) || directiveProblems(sent[0], viewport).length) wrong.push(`${c.id} "${c.say}" → ${id}`);
    }
    // eslint-disable-next-line no-console
    console.log(`explicit open backstop: opened ${opened.length} of ${REDIRECT_CASES.length} suite requests (${opened.join(', ')})`);
    expect(wrong).toEqual([]);
    expect(opened).toEqual(expect.arrayContaining(['R53', 'R55', 'R57']));
  });

  it('does nothing when the model already navigated this turn', () => {
    const { session, sent } = fakeSession();
    expect(maybeRunExplicitOpenBackstop(deps, session, 'Show me the screen where I can make a post', true)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('does nothing while a navigation is pending or the session is closing for one', () => {
    for (const over of [{ pendingNavigation: { screen_id: 'X' } }, { navigationDispatched: true }, { active: false }]) {
      const { session } = fakeSession(over);
      expect(maybeRunExplicitOpenBackstop(deps, session, 'open my wallet', false)).toBeNull();
    }
  });

  it('defers to a navigation the model makes while the resolver runs', async () => {
    const { session, sent } = fakeSession();
    const run = maybeRunExplicitOpenBackstop(deps, session, 'Show me the screen where I can make a post', false);
    session.navigationDispatchedTurn = 3; // the model's own navigate landed first
    expect(await run).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('does nothing for a "where" question — the model offers, the member decides', () => {
    const { session } = fakeSession();
    expect(maybeRunExplicitOpenBackstop(deps, session, 'Where can I make a post for the community?', false)).toBeNull();
  });

  it('does nothing when no single screen clearly fits (the model asks which one)', async () => {
    // R01: the wallet page and the wallet popup both fit.
    const { session, sent } = fakeSession();
    expect(await maybeRunExplicitOpenBackstop(deps, session, 'Take me to my wallet', false)).toBeNull();
    expect(sent).toHaveLength(0);
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'nav_open_backstop', expect.objectContaining({ outcome: 'ambiguous' }));
  });

  it('does nothing on role surfaces the registry does not cover', () => {
    const { session } = fakeSession({ current_route: '/admin/users' });
    expect(maybeRunExplicitOpenBackstop(deps, session, 'open my wallet', false)).toBeNull();
  });

  it('is off with ORB_NAV_OPEN_BACKSTOP_ENABLED=false, and without the registry dispatcher', () => {
    const { session } = fakeSession();
    process.env.ORB_NAV_OPEN_BACKSTOP_ENABLED = 'false';
    expect(maybeRunExplicitOpenBackstop(deps, session, 'open my wallet', false)).toBeNull();
    delete process.env.ORB_NAV_OPEN_BACKSTOP_ENABLED;
    process.env.NAV_V2_ENABLED = 'false';
    expect(maybeRunExplicitOpenBackstop(deps, session, 'open my wallet', false)).toBeNull();
    process.env.NAV_V2_ENABLED = 'true';
  });
});

describe('VTID-04644 wiring', () => {
  const handler = fs.readFileSync(path.join(__dirname, '../../src/orb/live/session/upstream-message-handler.ts'), 'utf8');
  const widget = fs.readFileSync(path.join(__dirname, '../../src/frontend/command-hub/orb-widget.js'), 'utf8');

  it('turn_complete reads the per-turn marker before advancing turn_count, then runs the backstop', () => {
    const body = handler.slice(handler.indexOf('export function handleTurnComplete('));
    const snap = body.indexOf('const navigatedDuringTurn = navigationDispatchedThisTurn(session);');
    const inc = body.indexOf('session.turn_count++;');
    const call = body.indexOf('maybeRunExplicitOpenBackstop(ctx.deps, session, userText, navigatedDuringTurn);');
    expect(snap).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(inc);
    expect(call).toBeGreaterThan(inc);
  });

  it('the widget runs an after_turn directive at once instead of holding it for a turn_complete that already passed', () => {
    const i = widget.indexOf('if (msg.after_turn === true) {');
    expect(i).toBeGreaterThan(-1);
    const block = widget.slice(i, i + 500);
    expect(block).toContain('_runNavDirective(msg, _s._sessionGeneration);');
    expect(widget.indexOf('if (msg.after_turn === true) {')).toBeLessThan(widget.indexOf('_s.pendingNavDirective = msg;'));
  });
});
