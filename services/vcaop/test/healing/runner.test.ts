import { runHealthAndHeal } from '../../src/healing/runner';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { HumanTask } from '../../src/guardrails/human-gate';

describe('runHealthAndHeal', () => {
  test('healthy system → status healthy, no escalation', async () => {
    const oasis = new InMemoryOasisSink();
    const tasks: HumanTask[] = [];
    const out = await runHealthAndHeal({ oasis, emitHumanTask: (t) => tasks.push(t) });
    expect(out).toEqual({ status: 'healthy' });
    expect(tasks).toHaveLength(0);
  });
});
