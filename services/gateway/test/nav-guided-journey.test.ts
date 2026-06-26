/**
 * NAV-GUIDED-JOURNEY — "show me my Guided Journey" must land in the GUIDED mode
 * of My Journey, not the Full app. Since guided is a durable mode (not a route),
 * navigate flips the journey mode to 'guided' before opening /autopilot.
 * consultNavigator + the journey-mode service are mocked (deterministic, no DB).
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
const mockConsult = jest.fn();
jest.mock('../src/services/navigator-consult', () => ({
  consultNavigator: (...a: any[]) => mockConsult(...a),
}));
const mockSetMode = jest.fn().mockResolvedValue({ mode: 'guided' });
jest.mock('../src/services/guided-journey/guided-journey-state', () => ({
  setJourneyMode: (...a: any[]) => mockSetMode(...a),
}));

import { tool_navigate } from '../src/services/orb-tools-shared';

const sbStub: any = {};
const authedId = {
  user_id: 'u-1', tenant_id: 't-1', vitana_id: 'v', role: 'community',
  lang: 'en', session_id: 's-1', is_anonymous: false, is_mobile: false,
} as any;

function confidentMyJourney() {
  mockConsult.mockResolvedValue({
    primary: { screen_id: 'AUTOPILOT.MY_JOURNEY', route: '/autopilot', title: 'My Journey' },
    confidence: 'high', decision: 'confident',
    alternatives: [{ screen_id: 'AUTOPILOT.MY_JOURNEY', route: '/autopilot', title: 'My Journey' }],
    explanation: '', kb_excerpts: [], kb_excerpt_count: 0, memory_hint_count: 0, ms_elapsed: 1,
  });
}

beforeEach(() => {
  mockConsult.mockReset();
  mockSetMode.mockClear();
  delete process.env.NAV_GUIDED_JOURNEY;
  confidentMyJourney();
});

describe('NAV-GUIDED-JOURNEY', () => {
  test('flag ON + guided intent → flips durable mode to guided, then opens /autopilot', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    const r: any = await tool_navigate({ question: 'show me my guided journey' }, authedId, sbStub);
    expect(mockSetMode).toHaveBeenCalledTimes(1);
    expect(mockSetMode.mock.calls[0]).toEqual([sbStub, 'u-1', 'guided']);
    expect(r.ok).toBe(true);
    expect(r.result.route).toBe('/autopilot');
    // Vitana is told to explain the difference + how to switch.
    expect(r.text).toContain('GUIDED JOURNEY');
    expect(r.text).toContain('Einführung/Vollversion');
  });

  test('full-app intent → flips durable mode to full + explains the difference', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    const r: any = await tool_navigate({ question: 'show me the full app version' }, authedId, sbStub);
    expect(mockSetMode).toHaveBeenCalledTimes(1);
    expect(mockSetMode.mock.calls[0]).toEqual([sbStub, 'u-1', 'full']);
    expect(r.text).toContain('FULL app');
    expect(r.text).toContain('Einführung/Vollversion');
  });

  test('German "geführte" / "Einführung" intent also flips the mode', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    await tool_navigate({ question: 'zeig mir wo ich in meinem guided journey stehe' }, authedId, sbStub);
    expect(mockSetMode).toHaveBeenCalledTimes(1);
  });

  test('flag OFF → mode is never touched', async () => {
    await tool_navigate({ question: 'show me my guided journey' }, authedId, sbStub);
    expect(mockSetMode).not.toHaveBeenCalled();
  });

  test('flag ON but plain "my journey" (no guided) → mode untouched (opens Full as before)', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    await tool_navigate({ question: 'open my journey' }, authedId, sbStub);
    expect(mockSetMode).not.toHaveBeenCalled();
  });

  // Widened phrase matching: natural paraphrases must resolve to the right mode,
  // not just the literal words "guided" / "full app".
  describe('widened phrase matching', () => {
    const GUIDED_PHRASES = [
      'take me to the simple version of my journey',
      'I want the step by step journey',
      'open the beginner mode of my journey',
      'walk me through my journey',
      'zeig mir den Anfänger-Modus meiner Journey',
      'bring mich zur einfachen Journey',
      'die geführte Einführung bitte',
      'show me the easy mode',
      'open the tutorial journey',
    ];
    const FULL_PHRASES = [
      'take me to the complete version of my journey',
      'I want the advanced journey',
      'show me everything on my journey',
      'open the pro mode of my journey',
      'zeig mir die Vollversion meiner Journey',
      'ich will die komplette App-Journey',
      'bring mich zur erweiterten Journey',
      'show me all features of my journey',
    ];

    test.each(GUIDED_PHRASES)('guided variant: "%s" → guided', async (q) => {
      process.env.NAV_GUIDED_JOURNEY = 'true';
      await tool_navigate({ question: q }, authedId, sbStub);
      expect(mockSetMode).toHaveBeenCalledTimes(1);
      expect(mockSetMode.mock.calls[0][2]).toBe('guided');
    });

    test.each(FULL_PHRASES)('full variant: "%s" → full', async (q) => {
      process.env.NAV_GUIDED_JOURNEY = 'true';
      await tool_navigate({ question: q }, authedId, sbStub);
      expect(mockSetMode).toHaveBeenCalledTimes(1);
      expect(mockSetMode.mock.calls[0][2]).toBe('full');
    });

    test('neutral phrasing still does NOT switch (no false positive)', async () => {
      process.env.NAV_GUIDED_JOURNEY = 'true';
      await tool_navigate({ question: 'just take me to my journey please' }, authedId, sbStub);
      expect(mockSetMode).not.toHaveBeenCalled();
    });
  });

  // NEGATION: "the FULL app, NOT the guided journey" must resolve to FULL even
  // though the word "guided" appears — the rejected mode must never win.
  describe('negation handling (X not Y)', () => {
    const CASES: Array<[string, 'guided' | 'full']> = [
      ['navigate me to my longevity journey, the full app not the guided journey', 'full'],
      ['the guided journey, not the full app', 'guided'],
      ['bring mich zur Vollversion, nicht zur geführten Journey', 'full'],
      ['zeig mir die geführte Journey, nicht die Vollversion', 'guided'],
      ['I don’t want the guided journey, give me the full app', 'full'],
    ];
    test.each(CASES)('"%s" → %s', async (q, expected) => {
      process.env.NAV_GUIDED_JOURNEY = 'true';
      await tool_navigate({ question: q }, authedId, sbStub);
      expect(mockSetMode).toHaveBeenCalledTimes(1);
      expect(mockSetMode.mock.calls[0][2]).toBe(expected);
    });
  });
});

// NAV_CONTINUATION_BIND — auto-capture nav offers (invariant #10, produce side):
// when the navigator OFFERS (confirmation_needed, two resolved targets) instead
// of auto-navigating, record the PRIMARY as pending_cta so a later "Ja" binds.
describe('NAV-CONTINUATION-BIND auto-capture (navigator confirmation offer)', () => {
  function makeSb() {
    const upserts: any[] = [];
    const sb: any = {
      from: () => ({ upsert: (row: any) => { upserts.push(row); return Promise.resolve({ error: null }); } }),
    };
    return { sb, upserts };
  }
  function confirmationNeeded() {
    // Live disambiguation shape: decision='ambiguous' with ≥2 alternatives.
    mockConsult.mockResolvedValue({
      decision: 'ambiguous',
      primary: { screen_id: 'COMM.FIND_PARTNER', route: '/comm/find-partner', title: 'Find a Partner' },
      alternatives: [
        { screen_id: 'COMM.FIND_PARTNER', route: '/comm/find-partner', title: 'Find a Partner' },
        { screen_id: 'COMM.EVENTS', route: '/comm/events', title: 'Events' },
      ],
      suggested_question: 'Find a Partner or Events?',
      confidence: 'low', explanation: '', kb_excerpts: [], kb_excerpt_count: 0,
      memory_hint_count: 0, ms_elapsed: 1,
    });
  }

  afterEach(() => { delete process.env.NAV_CONTINUATION_BIND; });

  test('flag ON → writes pending_cta for the PRIMARY resolved target', async () => {
    process.env.NAV_CONTINUATION_BIND = 'true';
    confirmationNeeded();
    const { sb, upserts } = makeSb();
    const r: any = await tool_navigate({ question: 'find me something' }, authedId, sb);
    expect(r.result.decision).toBe('ambiguous'); // still asks the user
    expect(upserts).toHaveLength(1);
    expect(upserts[0].key).toBe('pending_cta');
    expect(upserts[0].value.tool).toBe('navigate_to_screen');
    expect(upserts[0].value.payload).toEqual({
      screen_id: 'COMM.FIND_PARTNER', route: '/comm/find-partner', title: 'Find a Partner',
    });
  });

  test('flag OFF → no pending_cta written', async () => {
    confirmationNeeded();
    const { sb, upserts } = makeSb();
    await tool_navigate({ question: 'find me something' }, authedId, sb);
    expect(upserts).toHaveLength(0);
  });
});
