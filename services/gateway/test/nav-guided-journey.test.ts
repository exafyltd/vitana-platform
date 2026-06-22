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
});
