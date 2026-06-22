/**
 * NAV_CONTINUATION_BIND — unit tests for the continuation acceptance gate
 * (design invariant #10). Pure decision core: affirmation detection + one-shot
 * pending_cta resolution. No realtime / Supabase dependency (deps injected).
 */
import {
  detectAcceptance,
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

describe('maybeBindAcceptance', () => {
  const pending: PendingCtaValue = {
    tool: 'navigate_to_screen',
    payload: { screen_id: 'AUTOPILOT.MY_JOURNEY' },
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
      payload: { screen_id: 'AUTOPILOT.MY_JOURNEY' },
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

  test('payload defaults to {} when stored cta has none', async () => {
    const { deps } = makeDeps({ tool: 'open_autopilot' });
    const r = await maybeBindAcceptance({ userText: 'yes', userId: 'u-1' }, deps);
    expect(r).toEqual({ tool: 'open_autopilot', payload: {}, source: 'pending_cta' });
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
