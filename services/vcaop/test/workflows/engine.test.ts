/** Phase 4 — engine mechanics: retry, timeout, durability/resume, breaker, reconcile. */
import {
  EngineEvent,
  InMemoryWorkflowStore,
  WorkflowDefinition,
  WorkflowEngine,
} from '../../src/workflows/engine';

const instantSleep = async () => undefined;

function makeEngine(overrides: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {}) {
  const store = new InMemoryWorkflowStore();
  const events: EngineEvent[] = [];
  const engine = new WorkflowEngine({ store, emit: (e) => events.push(e), sleep: instantSleep, ...overrides });
  return { engine, store, events };
}

const runOpts = (key: string) => ({ correlationId: 'corr-1', tenantId: 'tenant-a', idempotencyKey: key });

describe('workflow engine mechanics', () => {
  test('retry with bounded backoff: transient failures then success, attempts recorded', async () => {
    const { engine } = makeEngine();
    let calls = 0;
    const def: WorkflowDefinition = {
      name: 'retry-test',
      version: '1.0.0',
      steps: [
        {
          key: 'flaky',
          maxAttempts: 3,
          run: async () => {
            calls += 1;
            if (calls < 3) throw new Error('transient');
            return 'ok';
          },
        },
      ],
    };
    const run = await engine.startRun(def, {}, runOpts('retry-1'));
    expect(run.status).toBe('completed');
    expect(run.steps[0].attempts).toBe(3);
  });

  test('idempotent command: same idempotency key returns the SAME run, steps execute once', async () => {
    const { engine } = makeEngine();
    let executions = 0;
    const def: WorkflowDefinition = {
      name: 'idem-test',
      version: '1.0.0',
      steps: [{ key: 'once', run: async () => ++executions }],
    };
    const a = await engine.startRun(def, {}, runOpts('idem-1'));
    const b = await engine.startRun(def, {}, runOpts('idem-1'));
    expect(b.id).toBe(a.id);
    expect(executions).toBe(1);
  });

  test('step timeout fails the step and the run', async () => {
    const { engine, store } = makeEngine();
    const def: WorkflowDefinition = {
      name: 'timeout-test',
      version: '1.0.0',
      steps: [
        {
          key: 'slow',
          maxAttempts: 1,
          timeoutMs: 50,
          run: () => new Promise((resolve) => setTimeout(resolve, 5_000).unref?.()),
        },
      ],
    };
    const run = await engine.startRun(def, {}, runOpts('timeout-1'));
    expect(run.status).toBe('failed'); // nothing completed → failed, not compensated
    expect(run.steps[0].error).toContain('timed out');
    expect((await store.listDeadLetters())).toHaveLength(1);
  });

  test('durability + resume: a crash after step 1 resumes at step 2 without re-running step 1', async () => {
    const { engine, store } = makeEngine();
    const executed: string[] = [];
    const crashingDef: WorkflowDefinition = {
      name: 'resume-test',
      version: '1.0.0',
      steps: [
        { key: 's1', run: async () => (executed.push('s1'), 'r1') },
        {
          key: 's2',
          maxAttempts: 1,
          run: async () => {
            throw new Error('process crashed'); // simulated crash on first run
          },
        },
        { key: 's3', run: async (ctx) => (executed.push('s3'), `saw:${ctx.results.s1}`) },
      ],
    };
    const crashed = await engine.startRun(crashingDef, {}, runOpts('resume-1'));
    expect(crashed.status).toBe('compensated'); // s1 completed (no compensate fn), s2 failed

    // Simulate the stuck-running variant: rewind the persisted record to
    // "running at cursor 1" as a crash between persist points would leave it.
    const persisted = (await store.getRun(crashed.id))!;
    persisted.status = 'running';
    persisted.cursor = 1;
    persisted.steps = persisted.steps.filter((s) => s.key === 's1' && (s.status = 'completed'));
    await store.updateRun(persisted);

    const fixedDef: WorkflowDefinition = {
      ...crashingDef,
      steps: [crashingDef.steps[0], { key: 's2', run: async () => (executed.push('s2'), 'r2') }, crashingDef.steps[2]],
    };
    const resumed = await engine.resume(crashed.id, fixedDef);
    expect(resumed.status).toBe('completed');
    // s1 ran exactly once; s3 saw s1's persisted result.
    expect(executed).toEqual(['s1', 's2', 's3']);
    expect(resumed.steps.find((s) => s.key === 's3')?.result).toBe('saw:r1');
  });

  test('resume of a terminal run is an idempotent no-op', async () => {
    const { engine } = makeEngine();
    const def: WorkflowDefinition = { name: 'noop', version: '1.0.0', steps: [{ key: 's', run: async () => 1 }] };
    const run = await engine.startRun(def, {}, runOpts('noop-1'));
    const again = await engine.resume(run.id, def);
    expect(again.status).toBe('completed');
    expect(again.steps).toHaveLength(1);
  });

  test('circuit breaker opens after threshold and fails fast until cooldown', async () => {
    let t = 0;
    const { engine } = makeEngine({ breakerThreshold: 2, breakerCooldownMs: 1_000, now: () => t });
    const def: WorkflowDefinition = {
      name: 'breaker-test',
      version: '1.0.0',
      steps: [{ key: 'downstream', maxAttempts: 1, run: async () => Promise.reject(new Error('down')) }],
    };
    await engine.startRun(def, {}, runOpts('brk-1'));
    await engine.startRun(def, {}, runOpts('brk-2')); // trips the breaker (2 failures)
    const fastFailed = await engine.startRun(def, {}, runOpts('brk-3'));
    expect(fastFailed.status).toBe('failed');
    expect(fastFailed.steps).toHaveLength(0); // breaker open → step never executed
    // After cooldown, the half-open probe lets a healthy call through.
    t = 2_000;
    let healthy = false;
    const healed: WorkflowDefinition = {
      name: 'breaker-test',
      version: '1.0.0',
      steps: [{ key: 'downstream', maxAttempts: 1, run: async () => (healthy = true) }],
    };
    const ok = await engine.startRun(healed, {}, runOpts('brk-4'));
    expect(ok.status).toBe('completed');
    expect(healthy).toBe(true);
  });

  test('reconcile marks long-running runs stuck exactly once', async () => {
    let t = 0;
    const { engine, store, events } = makeEngine({ now: () => t });
    const def: WorkflowDefinition = {
      name: 'stuck-test',
      version: '1.0.0',
      steps: [{ key: 's1', run: async () => 1 }],
    };
    const run = await engine.startRun(def, {}, runOpts('stuck-1'));
    // Force a running snapshot as a crashed process would leave it.
    const persisted = (await store.getRun(run.id))!;
    persisted.status = 'running';
    await store.updateRun(persisted);

    t = 10 * 60_000;
    const stuck = await engine.reconcile(5 * 60_000);
    expect(stuck.map((s) => s.id)).toEqual([run.id]);
    const again = await engine.reconcile(5 * 60_000);
    expect(again).toEqual([]); // repetition ≠ signal — one transition, one event
    expect(events.filter((e) => e.topic === 'mesh.workflow.stuck')).toHaveLength(1);
  });
});
