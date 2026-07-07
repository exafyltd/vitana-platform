/**
 * VTID-03108 / Step-1c (VTID-03366): cadence-suppressed silence.
 *
 * When wake-brief returns a cadence-class skip (transparent reconnect,
 * recent-turn-continues-thread, greeted-recently-within-window, isReconnect,
 * bucket=reconnect, or greeting_policy_skip), the opener MUST stay silent — no
 * legacy menu. That decision (`silenced_on_cadence`) now lives in the SINGLE
 * BRAIN (services/conversation/compute-greeting-decision.ts), golden-
 * characterized in compute-greeting-decision.golden.test.ts, and the Vertex
 * transport (routes/orb-live.ts) DELEGATES to it: a null directive renders no
 * ws.send and arms no watchdog.
 *
 * This replaces the old source-pattern test that asserted the inline cadence
 * block, which the Step-1c strangle removed.
 */
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY_SRC = path.resolve(__dirname, '../../../../src');
const brain = fs.readFileSync(
  path.join(GATEWAY_SRC, 'services/conversation/compute-greeting-decision.ts'),
  'utf8',
);
const orbLive = fs.readFileSync(path.join(GATEWAY_SRC, 'routes/orb-live.ts'), 'utf8');

describe('VTID-03108 / 1c: cadence-silence lives in the brain; transport delegates', () => {
  it('the silenced_on_cadence rung + the cadence-skip reason whitelist are in the brain', () => {
    expect(brain).toMatch(/wakeOpener: 'silenced_on_cadence'/);
    for (const reason of [
      'isReconnect_forces_skip',
      'transparent_reconnect_forces_skip',
      'bucket_reconnect_forces_skip',
      'recent_turn_continues_thread',
      'greeted_recently_within_window',
      'greeting_policy_skip',
    ]) {
      expect(brain).toContain(reason);
    }
  });

  it('a silent decision renders no directive (null) and arms no watchdog — modelled in the brain', () => {
    // silenced_on_cadence + silent_reconnect both return directive: null with
    // armWatchdog: false; the transport only ws.sends / arms when non-null / true.
    expect(brain).toMatch(/directive: null/);
    expect(brain).toMatch(/armWatchdog: false/);
    expect(orbLive).toMatch(/if \(_syncDecision\.directive !== null\)/);
    expect(orbLive).toMatch(/if \(_syncDecision\.effects\.armWatchdog\)/);
  });

  it('orb-live.ts no longer carries the inline cadence-silence branch', () => {
    expect(orbLive).not.toMatch(/wake_opener: 'silenced_on_cadence'/);
    expect(orbLive).toMatch(/computeGreetingDecision\(\{/);
  });
});
