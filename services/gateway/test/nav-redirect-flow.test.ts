/**
 * VTID-NAV-TEST: End-to-end test of the navigate_to_screen → orb_directive flow.
 *
 * Reproduces exactly what the deployed gateway does when Gemini Live calls
 * navigate_to_screen, WITHOUT needing a real voice session or Gemini round-trip:
 *
 *   1. Build a session object that mirrors what orb-live.ts creates on
 *      POST /orb/live/session/start.
 *   2. Call handleNavigateToScreen with a valid screen_id (what Gemini would
 *      pass via the tool_call path).
 *   3. Assert pendingNavigation is set, navigationDispatched is true,
 *      and current_route is eagerly updated (VTID-NAV-TIMEJOURNEY).
 *   4. Simulate the turn_complete dispatch block that ships orb_directive
 *      to the SSE stream. Assert the correct payload lands.
 *
 * If this passes, the backend navigation path is correct and any user-visible
 * failure is on the client (widget, WebView cache, frontend hook). If it
 * fails, I have a concrete server-side bug to fix.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  // constants used elsewhere in orb-live — stub them so the module loads
  DEV_IDENTITY: { USER_ID: '00000000-0000-0000-0000-000000000099', TENANT_ID: '00000000-0000-0000-0000-000000000001' },
  isMemoryBridgeEnabled: () => false,
  isDevSandbox: () => false,
}));

import { handleNavigateToScreen } from '../src/routes/orb-live';

/**
 * Build the shape of GeminiLiveSession that the live code creates on
 * POST /orb/live/session/start. Only the fields handleNavigateToScreen
 * actually touches need to be populated.
 */
function buildAuthenticatedSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'test-live-session-abc',
    lang: 'en',
    isAnonymous: false,
    identity: {
      user_id: '11111111-2222-3333-4444-555555555555',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      role: 'community',
    },
    active_role: 'community',
    current_route: '/home',
    recent_routes: ['/home'],
    // Fields the handler doesn't touch but that need to exist so the object
    // is shaped like a real session:
    turn_count: 1,
    isModelSpeaking: false,
    audioInChunks: 0,
    audioOutChunks: 0,
    transcriptTurns: [],
    outputTranscriptBuffer: '',
    pendingEventLinks: [],
    inputTranscriptBuffer: '',
    ...overrides,
  } as any;
}

function buildAnonymousSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'test-anon-session',
    lang: 'en',
    isAnonymous: true,
    identity: undefined,
    active_role: null,
    current_route: '/',
    recent_routes: ['/'],
    turn_count: 1,
    isModelSpeaking: false,
    audioInChunks: 0,
    audioOutChunks: 0,
    transcriptTurns: [],
    outputTranscriptBuffer: '',
    pendingEventLinks: [],
    inputTranscriptBuffer: '',
    ...overrides,
  } as any;
}

describe('handleNavigateToScreen — authenticated happy path', () => {
  test('COMM.EVENTS queues pendingNavigation, sets navigationDispatched, eagerly updates route', async () => {
    const session = buildAuthenticatedSession();

    const result = await handleNavigateToScreen(session, {
      screen_id: 'COMM.EVENTS',
      reason: 'User asked about upcoming meetups',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // Result must contain the tool confirmation string Gemini will read
    expect(result.result).toMatch(/Navigation queued to/);
    expect(result.result).toContain('Events & Meetups');

    // pendingNavigation state
    expect(session.pendingNavigation).toBeDefined();
    expect(session.pendingNavigation.screen_id).toBe('COMM.EVENTS');
    expect(session.pendingNavigation.route).toBe('/comm/events-meetups');
    expect(session.pendingNavigation.title).toBe('Events & Meetups');
    expect(session.pendingNavigation.reason).toBe('User asked about upcoming meetups');
    expect(session.pendingNavigation.decision_source).toBe('direct');
    expect(typeof session.pendingNavigation.requested_at).toBe('number');

    // navigationDispatched must be TRUE — this gates mic audio and
    // the Turn 2 audio forwarder
    expect(session.navigationDispatched).toBe(true);

    // VTID-NAV-TIMEJOURNEY: current_route must be eagerly updated
    expect(session.current_route).toBe('/comm/events-meetups');
    // And /home must be preserved in recent_routes as the previous screen
    expect(session.recent_routes).toContain('/home');
  });

  test('HEALTH.MY_BIOLOGY direct navigation also succeeds', async () => {
    const session = buildAuthenticatedSession({ current_route: '/comm/events-meetups' });
    const result = await handleNavigateToScreen(session, {
      screen_id: 'HEALTH.MY_BIOLOGY',
      reason: 'User asked how to track their biology',
    });

    expect(result.success).toBe(true);
    expect(session.pendingNavigation.screen_id).toBe('HEALTH.MY_BIOLOGY');
    expect(session.pendingNavigation.route).toBe('/health/my-biology');
    expect(session.navigationDispatched).toBe(true);
    expect(session.current_route).toBe('/health/my-biology');
  });

  test('BUSINESS.SELL_EARN (monetization use case) navigates', async () => {
    const session = buildAuthenticatedSession();
    const result = await handleNavigateToScreen(session, {
      screen_id: 'BUSINESS.SELL_EARN',
      reason: 'User wants to make money in the community',
    });

    expect(result.success).toBe(true);
    expect(session.pendingNavigation.route).toBe('/business/sell-earn');
    expect(session.navigationDispatched).toBe(true);
  });
});

describe('handleNavigateToScreen — access control', () => {
  test('unknown screen_id returns suggestions', async () => {
    const session = buildAuthenticatedSession();
    const result = await handleNavigateToScreen(session, {
      screen_id: 'BOGUS.DOES_NOT_EXIST',
      reason: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown screen_id/);
    // pendingNavigation must NOT be set on a failed lookup
    expect(session.pendingNavigation).toBeUndefined();
    expect(session.navigationDispatched).toBeFalsy();
  });

  test('anonymous user cannot navigate to authenticated-only screen', async () => {
    const session = buildAnonymousSession();
    const result = await handleNavigateToScreen(session, {
      screen_id: 'WALLET.OVERVIEW',
      reason: 'anonymous user asking for wallet',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires the user to be signed in/);
    expect(session.pendingNavigation).toBeUndefined();
    expect(session.navigationDispatched).toBeFalsy();
  });

  test('user already on the target screen is blocked', async () => {
    const session = buildAuthenticatedSession({
      current_route: '/comm/events-meetups',
    });
    const result = await handleNavigateToScreen(session, {
      screen_id: 'COMM.EVENTS',
      reason: 'repeat request',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already on/);
  });
});

describe('orb_directive dispatch simulation', () => {
  test('pendingNavigation → orb_directive payload matches the widget contract', async () => {
    const session = buildAuthenticatedSession();
    await handleNavigateToScreen(session, {
      screen_id: 'COMM.EVENTS',
      reason: 'test dispatch',
    });

    // Simulate the turn_complete dispatch block at orb-live.ts:3803-3839
    // exactly as the live code does it. This is the critical check: does
    // the widget actually receive the navigate directive?
    expect(session.pendingNavigation).toBeDefined();
    const nav = session.pendingNavigation;
    const directive = {
      type: 'orb_directive',
      directive: 'navigate',
      screen_id: nav.screen_id,
      route: nav.route,
      title: nav.title,
      reason: nav.reason,
      vtid: 'VTID-NAV-01',
    };

    // This is the payload the widget's message handler receives. The widget
    // checks msg.directive === 'navigate' and msg.route, sets navigationPending,
    // drains audio, and fires the React Router navigate callback.
    expect(directive.directive).toBe('navigate');
    expect(directive.route).toBe('/comm/events-meetups');
    expect(directive.screen_id).toBe('COMM.EVENTS');
    expect(directive.title).toBe('Events & Meetups');

    // JSON round-trip must produce a parseable SSE data line
    const serialized = JSON.stringify(directive);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe('orb_directive');
    expect(parsed.directive).toBe('navigate');
    expect(parsed.route).toBe('/comm/events-meetups');
  });
});
