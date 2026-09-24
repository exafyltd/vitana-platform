/**
 * NAV_CONTINUATION_BIND — unit tests for the continuation acceptance gate
 * (design invariant #10). Pure decision core: affirmation detection + one-shot
 * pending_cta resolution. No realtime / Supabase dependency (deps injected).
 */
import {
  detectAcceptance,
  isAutoRunnableOffer,
  maybeBindAcceptance,
  type AcceptanceGateDeps,
  type PendingCtaValue,
} from '../src/services/assistant-continuation/acceptance-gate';

describe('detectAcceptance', () => {
  test.each([
    'Ja',
    'ja',
    'Ja!',
    'ja, zeig mir',
    'zeig mir',
    'zeig es mir',
    'mach das',
    'mach es',
    'klar',
    'na klar',
    'gerne',
    'okay',
    'ok',
    'perfekt',
    'yes',
    'yes please',
    'yeah, go for it',
    'sure',
    'show me',
    "let's go",
    'absolutely',
  ])('accepts affirmation: %p', (s) => {
    expect(detectAcceptance(s)).toBe(true);
  });

  test.each([
    '',
    '   ',
    null,
    undefined,
    'nein',
    'nein danke',
    'no',
    'nope',
    'nicht jetzt',
    'stop',
    'abbrechen',
    // redirect — "yes, but rather show me X" is steering elsewhere, NOT a clean accept
    'ja, aber lieber meine Termine',
    'ja, zeig mir lieber meine Nachrichten',
    'no, show me the calendar instead',
    // a real fresh request that happens to contain an affirmation word but is long
    'kannst du mir bitte zeigen wo meine termine heute sind',
    // substring, not whole word
    'willst du jagen gehen',
  ])('rejects non-acceptance: %p', (s) => {
    expect(detectAcceptance(s as string)).toBe(false);
  });
});

describe('isAutoRunnableOffer (VTID-04355)', () => {
  test.each<[string, unknown, boolean]>([
    ['well-formed navigate', { tool: 'navigate_to_screen', payload: { screen_id: 'A.B', route: '/a' } }, true],
    ['navigate without route', { tool: 'navigate_to_screen', payload: { screen_id: 'A.B' } }, false],
    ['navigate without payload', { tool: 'navigate_to_screen' }, false],
    ['navigate with non-string route', { tool: 'navigate_to_screen', payload: { screen_id: 'A.B', route: 7 } }, false],
    ['another tool', { tool: 'activate_recommendation', payload: { screen_id: 'A.B', route: '/a' } }, false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('%s → %p', (_label, cta, expected) => {
    expect(isAutoRunnableOffer(cta as any)).toBe(expected);
  });
});

describe('maybeBindAcceptance', () => {
  const pending: PendingCtaValue = {
    tool: 'navigate_to_screen',
    payload: { screen_id: 'AUTOPILOT.MY_JOURNEY', route: '/autopilot/my-journey' },
    offered_at: new Date().toISOString(),
  };

  function makeDeps(cta: PendingCtaValue | null) {
    const calls = { read: 0, clear: 0 };
    const deps: AcceptanceGateDeps = {
      readPendingCta: async () => {
        calls.read++;
        return cta;
      },
      clearPendingCta: async () => {
        calls.clear++;
      },
    };
    return { deps, calls };
  }

  test('acceptance + live pending_cta → returns the exact stored action and consumes it', async () => {
    const { deps, calls } = makeDeps(pending);
    const r = await maybeBindAcceptance({ userText: 'ja, zeig mir', userId: 'u-1' }, deps);
    expect(r).toEqual({
      tool: 'navigate_to_screen',
      payload: { screen_id: 'AUTOPILOT.MY_JOURNEY', route: '/autopilot/my-journey' },
      source: 'pending_cta',
    });
    expect(calls.read).toBe(1);
    expect(calls.clear).toBe(1); // one-shot consume
  });

  test('acceptance but NO pending_cta → null, nothing consumed', async () => {
    const { deps, calls } = makeDeps(null);
    const r = await maybeBindAcceptance({ userText: 'ja', userId: 'u-1' }, deps);
    expect(r).toBeNull();
    expect(calls.read).toBe(1);
    expect(calls.clear).toBe(0);
  });

  test('non-acceptance short-circuits BEFORE reading state (no fresh-search override)', async () => {
    const { deps, calls } = makeDeps(pending);
    const r = await maybeBindAcceptance(
      { userText: 'zeig mir lieber meine nachrichten', userId: 'u-1' },
      deps,
    );
    expect(r).toBeNull();
    expect(calls.read).toBe(0); // never even looked at pending_cta
    expect(calls.clear).toBe(0);
  });

  test('missing userId → null', async () => {
    const { deps, calls } = makeDeps(pending);
    const r = await maybeBindAcceptance({ userText: 'ja', userId: null }, deps);
    expect(r).toBeNull();
    expect(calls.read).toBe(0);
  });

  // VTID-04355: the gate only consumes an offer it will actually run. Both
  // turn-loop call sites dispatch navigate_to_screen with screen_id + route and
  // nothing else, so any other offer must stay in orb_session_state for the
  // model's own tool call (and for activate_recommendation's pending_cta
  // fallback) instead of being cleared and dropped.
  test.each<[string, PendingCtaValue]>([
    ['a non-navigation tool', { tool: 'activate_recommendation', payload: { recommendation_id: 'r-1' } }],
    ['a tool with no payload', { tool: 'open_autopilot' }],
    ['navigate_to_screen without route', { tool: 'navigate_to_screen', payload: { screen_id: 'AUTOPILOT.MY_JOURNEY' } }],
    ['navigate_to_screen without screen_id', { tool: 'navigate_to_screen', payload: { route: '/autopilot' } }],
    ['navigate_to_screen with blank fields', { tool: 'navigate_to_screen', payload: { screen_id: ' ', route: '' } }],
  ])('acceptance + %s → null and the offer is left in place', async (_label, cta) => {
    const { deps, calls } = makeDeps(cta);
    const r = await maybeBindAcceptance({ userText: 'ja', userId: 'u-1' }, deps);
    expect(r).toBeNull();
    expect(calls.read).toBe(1);
    expect(calls.clear).toBe(0);
  });

  test('fails open: reader throws → null (never blocks the turn)', async () => {
    const deps: AcceptanceGateDeps = {
      readPendingCta: async () => {
        throw new Error('db down');
      },
      clearPendingCta: async () => {},
    };
    const r = await maybeBindAcceptance({ userText: 'ja', userId: 'u-1' }, deps);
    expect(r).toBeNull();
  });
});
