import {
  SelfHealingOrchestrator,
  defaultLadder,
  Probe,
  ProbeResult,
  FailedCheck,
  NeedsEscalation,
} from '../../src/healing/orchestrator';
import { invariantProbe } from '../../src/healing/health-probe';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { HumanTask } from '../../src/guardrails/human-gate';

function fail(name: string, category: FailedCheck['category']): ProbeResult {
  return { ok: false, failed: [{ name, category }] };
}
const HEALTHY: ProbeResult = { ok: true, failed: [] };

function harness() {
  const oasis = new InMemoryOasisSink();
  const tasks: HumanTask[] = [];
  const escalations: unknown[] = [];
  return { oasis, tasks, escalations };
}

describe('Self-healing orchestrator', () => {
  test('healthy probe → no remediation', async () => {
    const { oasis, tasks } = harness();
    const orch = new SelfHealingOrchestrator(async () => HEALTHY, { oasis, emitHumanTask: (t) => tasks.push(t) });
    expect(await orch.runCycle()).toEqual({ status: 'healthy' });
    expect(oasis.events).toHaveLength(0);
  });

  test('service failure → recovered via rollback primitive, then verified green', async () => {
    const { oasis, tasks } = harness();
    const world = { healthy: false };
    const probe: Probe = async () => (world.healthy ? HEALTHY : fail('svc.alive', 'service'));
    const orch = new SelfHealingOrchestrator(probe, {
      oasis,
      emitHumanTask: (t) => tasks.push(t),
      ladder: defaultLadder({ rollbackToLastGoodRevision: async () => { world.healthy = true; } }),
    });
    const out = await orch.runCycle();
    expect(out).toMatchObject({ status: 'recovered', remediator: 'rollback-last-good-revision', frozen: false });
    expect(oasis.events.map((e) => e.type)).toEqual(['vcaop.heal.detected', 'vcaop.heal.remediating', 'vcaop.heal.recovered']);
    expect(tasks).toHaveLength(0); // no human needed
  });

  test('transient failure clears after retry', async () => {
    const { oasis, tasks } = harness();
    let calls = 0;
    const probe: Probe = async () => (++calls >= 2 ? HEALTHY : fail('blip', 'transient'));
    const orch = new SelfHealingOrchestrator(probe, { oasis, emitHumanTask: (t) => tasks.push(t), ladder: defaultLadder({ retry: async () => {} }) });
    expect((await orch.runCycle()).status).toBe('recovered');
  });

  test('GUARDRAIL failure is never auto-healed → immediate escalate + freeze', async () => {
    const { oasis, tasks, escalations } = harness();
    let rollbackCalled = false;
    const orch = new SelfHealingOrchestrator(async () => fail('guardrail.pii_redaction', 'guardrail'), {
      oasis,
      emitHumanTask: (t) => tasks.push(t),
      onEscalate: (i) => { escalations.push(i); },
      ladder: defaultLadder({ rollbackToLastGoodRevision: async () => { rollbackCalled = true; } }),
    });
    const out = await orch.runCycle();
    expect(out).toMatchObject({ status: 'escalated', reason: 'guardrail', frozen: true });
    expect(rollbackCalled).toBe(false); // no remediation attempted
    expect(tasks[0].type).toBe('PRIVILEGE_ESCALATION');
    expect(escalations).toHaveLength(1);
    expect(orch.isFrozen()).toBe(true);
    expect(oasis.events.map((e) => e.type)).toEqual(['vcaop.heal.detected', 'vcaop.heal.escalated']);
  });

  test('exhausted ladder (primitive does not fix) → escalate', async () => {
    const { oasis, tasks } = harness();
    const probe: Probe = async () => fail('svc.alive', 'service'); // never recovers
    const orch = new SelfHealingOrchestrator(probe, {
      oasis,
      emitHumanTask: (t) => tasks.push(t),
      ladder: defaultLadder({ rollbackToLastGoodRevision: async () => {} }),
    });
    const out = await orch.runCycle();
    expect(out).toMatchObject({ status: 'escalated', reason: 'exhausted', frozen: true });
    expect(tasks).toHaveLength(1);
  });

  test('no primitive available for the category → escalate (no_primitive)', async () => {
    const { oasis, tasks } = harness();
    const orch = new SelfHealingOrchestrator(async () => fail('schema.migration', 'schema'), {
      oasis,
      emitHumanTask: (t) => tasks.push(t),
      ladder: defaultLadder({}), // no runDownMigration provided
    });
    expect((await orch.runCycle())).toMatchObject({ status: 'escalated', reason: 'no_primitive' });
  });

  test('NeedsEscalation from a primitive bails out to a human', async () => {
    const { oasis, tasks } = harness();
    const orch = new SelfHealingOrchestrator(async () => fail('schema.migration', 'schema'), {
      oasis,
      emitHumanTask: (t) => tasks.push(t),
      ladder: defaultLadder({ runDownMigration: async () => { throw new NeedsEscalation('no tested rollback'); } }),
    });
    expect((await orch.runCycle())).toMatchObject({ status: 'escalated', reason: 'exhausted' });
  });

  test('self-improvement: a recovered signature is remembered', async () => {
    const { oasis, tasks } = harness();
    const world = { healthy: false };
    const probe: Probe = async () => (world.healthy ? HEALTHY : fail('svc.alive', 'service'));
    const orch = new SelfHealingOrchestrator(probe, {
      oasis,
      emitHumanTask: (t) => tasks.push(t),
      ladder: defaultLadder({ rollbackToLastGoodRevision: async () => { world.healthy = true; } }),
    });
    await orch.runCycle();
    expect(orch.knownRemedy([{ name: 'svc.alive', category: 'service' }])).toBe('rollback-last-good-revision');
  });
});

describe('invariant probe (in-process)', () => {
  test('reports healthy on a green system', async () => {
    const r = await invariantProbe();
    expect(r.ok).toBe(true);
    expect(r.failed).toHaveLength(0);
  });
});
