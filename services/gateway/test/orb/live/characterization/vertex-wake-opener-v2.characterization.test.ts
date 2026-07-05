/**
 * VTID-03104 / Step-1c (VTID-03366): the Vertex "teacher opener v2" (override_v2)
 * decision + its verbatim `Say exactly` / `Sage genau Folgendes` trigger shapes
 * now live in the SINGLE BRAIN
 * (services/conversation/compute-greeting-decision.ts) and are golden-
 * characterized in compute-greeting-decision.golden.test.ts. The Vertex transport
 * (routes/orb-live.ts) DELEGATES its sync opening rungs to the brain and renders
 * the returned directive.
 *
 * This test pins that split so (a) the override behaviour cannot silently
 * regress, and (b) the inline 9-branch ladder cannot drift back into the
 * transport. It replaces the old source-pattern test that asserted the inline
 * implementation, which the Step-1c strangle removed.
 */
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY_SRC = path.resolve(__dirname, '../../../../src');
const brain = fs.readFileSync(
  path.join(GATEWAY_SRC, 'services/conversation/compute-greeting-decision.ts'),
  'utf8',
);
const orbLive = fs.readFileSync(path.join(GATEWAY_SRC, 'routes/orb-live.ts'), 'utf8');

describe('VTID-03104 / 1c: override_v2 opener lives in the brain; transport delegates', () => {
  it('the override_v2 rung + verbatim trigger shapes are in the brain', () => {
    expect(brain).toMatch(/wakeOpener: 'override_v2'/);
    expect(brain).toMatch(/Say exactly: "\$\{safe\}"/);
    expect(brain).toMatch(/Sage genau Folgendes: "\$\{safe\}"/);
    // The double-quote escape that keeps the line from terminating the wrapper.
    expect(brain).toMatch(/wakeOverrideLine\.replace\(\/"\/g, '\\\\"'\)/);
  });

  it('the brain does NOT re-introduce the VTID-03102 phrasing that broke audio', () => {
    expect(brain).not.toMatch(/Use that line verbatim/);
    expect(brain).not.toMatch(/copy it letter-for-letter/);
    expect(brain).not.toMatch(/Begin your first turn now/);
  });

  it('the legacy menu fallback likewise lives in the brain', () => {
    expect(brain).toMatch(/pick ONE of: "Let me show you where we are\./);
  });

  it('orb-live.ts delegates the sync opening rungs to computeGreetingDecision', () => {
    expect(orbLive).toMatch(/computeGreetingDecision\(\{/);
    expect(orbLive).toMatch(/_syncDecision\.directive/);
    expect(orbLive).toMatch(/_syncDecision\.effects\.armWatchdog/);
  });

  it('orb-live.ts no longer carries the inline override / silent / cadence branches', () => {
    expect(orbLive).not.toMatch(/wake_opener: 'override_v2'/);
    expect(orbLive).not.toMatch(/wake_opener: 'silent_reconnect'/);
    expect(orbLive).not.toMatch(/wake_opener: 'silenced_on_cadence'/);
  });
});
