/**
 * VTID-05103 — in-gateway routine runner: due time, exactly-once claim,
 * failure handling, breach routing, switches, and the routine list.
 */
import {
  isDue,
  resetRoutineRunnerForTest,
  routineRunnerAllowed,
  runDueRoutines,
  startRoutineRunner,
  RunnerDeps,
} from '../../src/services/routine-runner/runner';
import { RUNNER_ROUTINES, RunnerRoutine } from '../../src/services/routine-runner/sources';

function deps(over: Partial<RunnerDeps> = {}) {
  const calls = { claim: [] as string[], finish: [] as any[], emit: [] as any[], route: [] as any[] };
  const d: RunnerDeps = {
    claim: async (name) => { calls.claim.push(name); return `run-${name}`; },
    finish: async (id, verdict, error) => { calls.finish.push({ id, verdict, error }); },
    emitBreach: async (routine, verdict) => { calls.emit.push({ routine, verdict }); },
    routeBreach: async (routine, verdict) => { calls.route.push({ routine, verdict }); },
    ...over,
  };
  return { d, calls };
}

const at = (iso: string) => new Date(iso);
const routine = (name: string, run: RunnerRoutine['run'], hour = 6, minute = 0): RunnerRoutine => ({ name, hour, minute, run });

beforeEach(() => resetRoutineRunnerForTest());

describe('isDue', () => {
  it('is due once the UTC run time has passed today', () => {
    expect(isDue({ hour: 6, minute: 30 }, at('2026-10-12T06:29:00Z'))).toBe(false);
    expect(isDue({ hour: 6, minute: 30 }, at('2026-10-12T06:30:00Z'))).toBe(true);
    expect(isDue({ hour: 6, minute: 30 }, at('2026-10-12T23:00:00Z'))).toBe(true);
  });
});

describe('runDueRoutines', () => {
  it('runs a due routine once: claim → run → finish', async () => {
    const { d, calls } = deps();
    const r = routine('x', async () => ({ status: 'success', summary: 'ok', findings: {} }));
    const res = await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [r]);
    expect(res).toEqual([{ name: 'x', outcome: 'ran', status: 'success' }]);
    expect(calls.finish).toEqual([{ id: 'run-x', verdict: { status: 'success', summary: 'ok', findings: {} }, error: null }]);
    // Same day again: settled in this process, no second claim.
    const again = await runDueRoutines(d, at('2026-10-12T08:00:00Z'), [r]);
    expect(again[0].outcome).toBe('settled');
    expect(calls.claim).toEqual(['x']);
  });

  it('runs again the next UTC day', async () => {
    const { d, calls } = deps();
    const r = routine('x', async () => ({ status: 'success', summary: 'ok', findings: {} }));
    await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [r]);
    await runDueRoutines(d, at('2026-10-13T07:00:00Z'), [r]);
    expect(calls.claim).toEqual(['x', 'x']);
  });

  it('a routine not yet due is not claimed', async () => {
    const { d, calls } = deps();
    const res = await runDueRoutines(d, at('2026-10-12T05:00:00Z'), [routine('x', async () => { throw new Error('no'); })]);
    expect(res[0].outcome).toBe('not_due');
    expect(calls.claim).toEqual([]);
  });

  it('claim returns null (another task, or disabled in the catalog) → nothing runs', async () => {
    const run = jest.fn();
    const { d, calls } = deps({ claim: async () => null });
    const res = await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [routine('x', run as any)]);
    expect(res[0].outcome).toBe('not_claimed');
    expect(run).not.toHaveBeenCalled();
    expect(calls.finish).toEqual([]);
  });

  it('a claim error is retried on the next tick', async () => {
    let fail = true;
    const { d, calls } = deps({ claim: async (n) => { if (fail) throw new Error('db down'); return `run-${n}`; } });
    const r = routine('x', async () => ({ status: 'success', summary: 'ok', findings: {} }));
    expect((await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [r]))[0].outcome).toBe('not_claimed');
    fail = false;
    expect((await runDueRoutines(d, at('2026-10-12T08:00:00Z'), [r]))[0].outcome).toBe('ran');
    expect(calls.finish).toHaveLength(1);
  });

  it('a loader that throws closes the run as failure (never left running)', async () => {
    const { d, calls } = deps();
    await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [routine('x', async () => { throw new Error('boom'); })]);
    expect(calls.finish[0].verdict.status).toBe('failure');
    expect(calls.finish[0].error).toBe('boom');
    expect(calls.emit).toEqual([]);
  });

  it('a breach emits the OASIS event and reaches the self-healing intake, then finishes', async () => {
    const { d, calls } = deps();
    const breach = { topic: 't.x', vtid: 'VTID-1', message: 'm', payload: {} };
    await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [routine('x', async () => ({ status: 'partial', summary: 's', findings: {}, breach }))]);
    expect(calls.emit).toEqual([{ routine: 'x', verdict: expect.objectContaining({ breach }) }]);
    expect(calls.route).toEqual([{ routine: 'x', verdict: expect.objectContaining({ breach }) }]);
    expect(calls.finish[0].verdict.status).toBe('partial');
  });

  it('a failing self-healing route never stops the run from finishing', async () => {
    const { d, calls } = deps({ routeBreach: async () => { throw new Error('intake down'); } });
    const breach = { topic: 't.x', vtid: 'VTID-1', message: 'm', payload: {} };
    await runDueRoutines(d, at('2026-10-12T07:00:00Z'), [routine('x', async () => ({ status: 'partial', summary: 's', findings: {}, breach }))]);
    expect(calls.finish).toHaveLength(1);
  });
});

describe('switches', () => {
  it('off unless ROUTINE_RUNNER_ENABLED is exactly "true"', () => {
    expect(routineRunnerAllowed({}).ok).toBe(false);
    expect(routineRunnerAllowed({ ROUTINE_RUNNER_ENABLED: 'TRUE' }).ok).toBe(false);
    expect(routineRunnerAllowed({ ROUTINE_RUNNER_ENABLED: 'true' }).ok).toBe(true);
  });
  it('never on staging (it shares the production database)', () => {
    expect(routineRunnerAllowed({ ROUTINE_RUNNER_ENABLED: 'true', VITANA_ENV: 'staging' }).ok).toBe(false);
  });
  it('startRoutineRunner returns false and claims nothing when off or on staging', () => {
    const { d, calls } = deps();
    expect(startRoutineRunner({}, d)).toBe(false);
    expect(startRoutineRunner({ ROUTINE_RUNNER_ENABLED: 'true', VITANA_ENV: 'staging' }, d)).toBe(false);
    expect(calls.claim).toEqual([]);
  });
});

describe('the routine list', () => {
  it('covers the 14 deterministic routines at their documented UTC times', () => {
    expect(RUNNER_ROUTINES.map((r) => `${r.name}@${r.hour}:${r.minute}`)).toEqual([
      'voice-lab-triage@4:30',
      'agents-heartbeat@5:30',
      'supabase-io-audit@6:0',
      'mobile-screen-latency-rollup@6:15',
      'autopilot-rec-quality@6:30',
      'oasis-event-anomaly@7:0',
      'llm-fallback-watch@7:15',
      'vitana-index-health@7:30',
      'knowledge-docs-freshness@9:0',
      'dyk-tour-progress@10:30',
      'spec-memory-quarantine@11:0',
      'learn-outcomes@12:0',
      'supplier-catalog-check@13:0',
      'llm-spend-budget@23:50',
    ]);
  });
  it('each time matches the routine spec\'s cron line', () => {
    const fs = require('fs');
    const path = require('path');
    for (const r of RUNNER_ROUTINES) {
      const md = fs.readFileSync(path.resolve(__dirname, '../../../../routines', `${r.name}.md`), 'utf8');
      expect(md).toContain(`\`${r.minute} ${r.hour} * * *\``);
    }
  });
});
