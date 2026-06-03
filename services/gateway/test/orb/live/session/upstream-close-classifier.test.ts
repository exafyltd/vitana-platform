/**
 * VTID-03234 (report finding #2) — upstream close classifier tests.
 *
 * Locks the rule that fixed the "internet issues" loop: transparent reconnects
 * (Vertex's normal ~5-min code=1000 close and watchdog stall-recovery) must
 * NOT produce a loud connection alert; only genuine disconnects do.
 */

import { classifyUpstreamClose } from '../../../../src/orb/live/session/upstream-close-classifier';

const base = {
  code: 1011,
  active: true,
  setupComplete: true,
  stallRecoveryPending: false,
  isPersonaSwap: false,
};

describe('classifyUpstreamClose', () => {
  it('code=1000 on an active session → transparent_reconnect (no loud alert)', () => {
    expect(classifyUpstreamClose({ ...base, code: 1000 })).toBe('transparent_reconnect');
  });

  it('watchdog stall-recovery → transparent_reconnect (no loud alert)', () => {
    expect(
      classifyUpstreamClose({ ...base, code: 1006, stallRecoveryPending: true }),
    ).toBe('transparent_reconnect');
  });

  it('persona swap → persona_swap (silent cue, not an alert)', () => {
    expect(classifyUpstreamClose({ ...base, code: 1000, isPersonaSwap: true })).toBe('persona_swap');
    // persona swap takes precedence even on a non-1000 close
    expect(classifyUpstreamClose({ ...base, isPersonaSwap: true })).toBe('persona_swap');
  });

  it('abnormal close (1006) with no stall recovery → genuine_disconnect (loud alert)', () => {
    expect(classifyUpstreamClose({ ...base, code: 1006 })).toBe('genuine_disconnect');
  });

  it('pre-setup close → ignore (connect path owns it)', () => {
    expect(classifyUpstreamClose({ ...base, setupComplete: false })).toBe('ignore');
  });

  it('inactive session → ignore (teardown path owns it)', () => {
    expect(classifyUpstreamClose({ ...base, active: false })).toBe('ignore');
  });

  it('the dominant production case — Vertex 5-min recycle on a healthy session — is silent', () => {
    // This is the case that previously fired "internet issues" 5-10x/min.
    const action = classifyUpstreamClose({
      code: 1000,
      active: true,
      setupComplete: true,
      stallRecoveryPending: false,
      isPersonaSwap: false,
    });
    expect(action).not.toBe('genuine_disconnect');
    expect(action).toBe('transparent_reconnect');
  });
});
