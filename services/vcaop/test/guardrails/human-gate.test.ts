import {
  requiresHuman,
  enforceHumanGate,
  HUMAN_REQUIRED_ACTIONS,
  HumanTask,
} from '../../src/guardrails/human-gate';
import { HumanTaskRequired } from '../../src/guardrails/errors';

describe('human-gate (Sec. 3) — not bypassable', () => {
  test('all HUMAN_REQUIRED actions are recognized', () => {
    for (const a of HUMAN_REQUIRED_ACTIONS) expect(requiresHuman(a)).toBe(true);
    expect(requiresHuman('READ_CATALOG')).toBe(false);
  });

  test('gated action emits a human_task AND throws (emit before throw)', () => {
    const emitted: HumanTask[] = [];
    expect(() =>
      enforceHumanGate('KYB', (t) => emitted.push(t), { assignee: 'officer-1', payload: { providerId: 'amazon' } }),
    ).toThrow(HumanTaskRequired);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('KYB');
    expect(emitted[0].assignee).toBe('officer-1');
  });

  test('non-gated action is a no-op (no emit, no throw)', () => {
    const emitted: HumanTask[] = [];
    expect(() => enforceHumanGate('OPERATE', (t) => emitted.push(t))).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  test('CAPTCHA and TRANSFER are gated', () => {
    expect(() => enforceHumanGate('CAPTCHA', () => {})).toThrow(HumanTaskRequired);
    expect(() => enforceHumanGate('TRANSFER', () => {})).toThrow(HumanTaskRequired);
  });
});
