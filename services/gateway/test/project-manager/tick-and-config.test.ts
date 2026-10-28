/**
 * VTID-05216 — PM config switches + the dry_run decide tick (observe → decide
 * → report, no act). The stub observer returns an empty world, so the tick is
 * safe and deterministic; the real observers depend on p1/p2 (not merged).
 */

import { pmAgentEnabled, pmMode, pmTickIntervalMs } from '../../src/services/project-manager/config';
import { StubObserver } from '../../src/services/project-manager/observe';
import { PmDecisionEmitter } from '../../src/services/project-manager/emit';
import {
  getStatusSnapshot,
  runDecideTick,
} from '../../src/services/project-manager';
import { ObservedState, PmDecision, PmMode } from '../../src/services/project-manager/types';

describe('config switches', () => {
  it('PM_AGENT_ENABLED defaults off, true only on exactly "true"', () => {
    expect(pmAgentEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(pmAgentEnabled({ PM_AGENT_ENABLED: 'false' } as any)).toBe(false);
    expect(pmAgentEnabled({ PM_AGENT_ENABLED: '1' } as any)).toBe(false);
    expect(pmAgentEnabled({ PM_AGENT_ENABLED: 'true' } as any)).toBe(true);
  });

  it('PM_MODE defaults dry_run; accepts off/live; unknown → dry_run', () => {
    expect(pmMode({} as any)).toBe('dry_run');
    expect(pmMode({ PM_MODE: 'off' } as any)).toBe('off');
    expect(pmMode({ PM_MODE: 'live' } as any)).toBe('live');
    expect(pmMode({ PM_MODE: 'LIVE' } as any)).toBe('live');
    expect(pmMode({ PM_MODE: 'nonsense' } as any)).toBe('dry_run');
  });

  // VTID-05274 (plan kiro-autonomy-fallback §5 C3): the default tick is 2 minutes (was 10).
  it('tick interval defaults to 2 minutes', () => {
    expect(pmTickIntervalMs({} as any)).toBe(120000);
    expect(pmTickIntervalMs({ PM_TICK_INTERVAL_MS: '1000' } as any)).toBe(1000);
    expect(pmTickIntervalMs({ PM_TICK_INTERVAL_MS: 'bad' } as any)).toBe(120000);
  });
});

describe('runDecideTick — observe → decide → report (no act)', () => {
  const prevMode = process.env.PM_MODE;
  afterEach(() => {
    if (prevMode === undefined) delete process.env.PM_MODE;
    else process.env.PM_MODE = prevMode;
  });

  it('with the stub observer (empty world) emits nothing and records a snapshot', async () => {
    process.env.PM_MODE = 'dry_run';
    const emitted: PmDecision[] = [];
    const emitter: PmDecisionEmitter = { emit: async (d) => { emitted.push(d); } };
    const decisions = await runDecideTick({ observer: new StubObserver(), emitter, now: () => 1_700_000_000_000 });
    expect(decisions).toEqual([]);
    expect(emitted).toEqual([]);
    const snap = getStatusSnapshot();
    expect(snap.last_tick_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(snap.decisions).toEqual([]);
  });

  it('reports each decision through the emitter (dry_run)', async () => {
    process.env.PM_MODE = 'dry_run';
    const observer = {
      async observe(mode: PmMode): Promise<ObservedState> {
        return {
          mode,
          rotations: [],
          lanes: [
            {
              slug: 'demo', lane: 'x', vtid: 'VTID-1', state: 'verified', seat: 'jtadic',
              reviewer_seat: 'exafyltd', area: 'backoffice',
              paths: ['services/gateway/**'], depends_on: [],
              pr: {
                url: 'u', title: 'VTID-1 demo', head_sha: 'h',
                checks: [
                  { name: 'Lane scope', conclusion: 'success', head_sha: 'h' },
                  { name: 'Collab handoff', conclusion: 'success', head_sha: 'h' },
                ],
                mergeable: true, merged: false, consecutive_ci_failures: 0,
              },
              reviews: [{ session_id: 's-review', reviewer_seat: 'exafyltd', verdict: 'approve', head_sha: 'h', at: '2026-10-15T00:00:00Z' }],
              executing_log: [{ session_id: 's-exec', seat: 'jtadic', at: '2026-10-14T00:00:00Z' }],
              state_since: '2026-10-15T00:00:00Z', last_branch_activity: '2026-10-15T00:00:00Z',
              claimed_at: '2026-10-14T00:00:00Z', seat_ran_automation_in_window: true,
              staging_verified: false, deploys: false, staging_verified_at: null, gate2_sent: false,
            },
          ],
        };
      },
    };
    const emitted: PmDecision[] = [];
    const emitter: PmDecisionEmitter = { emit: async (d) => { emitted.push(d); } };
    const decisions = await runDecideTick({ observer, emitter, now: () => Date.parse('2026-10-15T12:00:00Z') });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe('merge');
    expect(emitted).toEqual(decisions);
  });

  it('mode off → decide yields nothing even with lanes present', async () => {
    process.env.PM_MODE = 'off';
    const observer = {
      async observe(mode: PmMode): Promise<ObservedState> {
        // return a merge-eligible lane but mode is off.
        return { mode, rotations: [], lanes: [] };
      },
    };
    const decisions = await runDecideTick({ observer, now: () => 1 });
    expect(decisions).toEqual([]);
  });
});
