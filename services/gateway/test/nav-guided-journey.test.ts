/**
 * NAV-GUIDED-JOURNEY — "show me my Guided Journey" must land in the GUIDED mode
 * of My Journey, not the Full app. Since guided is a durable mode (not a route),
 * navigate flips the journey mode to 'guided' before opening /autopilot.
 * The registry resolver + the journey-mode service are mocked (deterministic,
 * no DB). VTID-04846: the switch runs on the registry path now.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
const mockResolve = jest.fn();
jest.mock('../src/navigation/nav-dispatch', () => ({
  ...jest.requireActual('../src/navigation/nav-dispatch'),
  navigateByRequest: (...a: any[]) => mockResolve(...a),
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
  const directive = { type: 'orb_directive', directive: 'navigate', screen_id: 'AUTOPILOT.MY_JOURNEY', route: '/autopilot', title: 'My Journey' };
  mockResolve.mockResolvedValue({
    ok: true,
    result: { screen_id: 'AUTOPILOT.MY_JOURNEY', route: '/autopilot', title: 'My Journey', entry_kind: 'route', directive },
    text: 'My Journey opens as soon as you finish speaking.',
  });
}

beforeEach(() => {
  mockResolve.mockReset();
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
    expect(r.text).toContain('AUDIOBOOK');
    expect(r.text).toContain('Hörbuch/Vollversion');
  });

  test('full-app intent → flips durable mode to full + explains the difference', async () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    const r: any = await tool_navigate({ question: 'show me the full app version' }, authedId, sbStub);
    expect(mockSetMode).toHaveBeenCalledTimes(1);
    expect(mockSetMode.mock.calls[0]).toEqual([sbStub, 'u-1', 'full']);
    expect(r.text).toContain('FULL app');
    expect(r.text).toContain('Hörbuch/Vollversion');
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
      // VTID-04760: the guided view is presented as the Audiobook / Hörbuch.
      'open my audiobook',
      'zeig mir mein Hörbuch',
      'spiel mein Hoerbuch in my journey',
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
      'show me the full app, not the audiobook',
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

// VTID-04846: the legacy consult's pending_cta capture is gone; the registry
// holds a "where" offer itself (test/navigation/nav-dispatch.test.ts,
// 'holds a "where" answer as an offer, and never an "open" one').
