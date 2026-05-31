import {
  runVoiceInstructionBudgetWatch,
  msUntilNextUtcHour,
} from '../../src/services/voice-instruction-budget-watch-cron';

jest.mock('../../src/services/voice-budget-watch', () => {
  const actual = jest.requireActual('../../src/services/voice-budget-watch');
  return { ...actual, fetchVoiceBudgetWatch: jest.fn() };
});

import { fetchVoiceBudgetWatch } from '../../src/services/voice-budget-watch';

const mockFetch = fetchVoiceBudgetWatch as jest.MockedFunction<typeof fetchVoiceBudgetWatch>;

describe('voice-instruction-budget-watch cron (Phase D)', () => {
  beforeEach(() => mockFetch.mockReset());

  const supabase = {} as Parameters<typeof runVoiceInstructionBudgetWatch>[0]['supabase'];

  it('emits one at_risk event per at-risk user and one overflow per overflow user', async () => {
    mockFetch.mockResolvedValue([
      { user_id: 'a', vitana_id: '@a', display_name: 'A', memory_items: 1, memory_chars: 9_000, memory_facts: 1, pct_of_cap: 75, severity: 'at_risk' },
      { user_id: 'b', vitana_id: '@b', display_name: 'B', memory_items: 1, memory_chars: 24_000, memory_facts: 1, pct_of_cap: 200, severity: 'overflow' },
      { user_id: 'c', vitana_id: '@c', display_name: 'C', memory_items: 1, memory_chars: 14_400, memory_facts: 1, pct_of_cap: 120, severity: 'overflow' },
    ]);
    const emit = jest.fn().mockResolvedValue({ ok: true });

    const res = await runVoiceInstructionBudgetWatch({ supabase, emit });

    expect(res).toEqual({ scanned: 3, atRisk: 1, overflow: 2 });
    expect(emit).toHaveBeenCalledTimes(3);

    const types = emit.mock.calls.map((c) => c[0].type);
    expect(types.filter((t) => t === 'voice.instruction.budget_at_risk')).toHaveLength(1);
    expect(types.filter((t) => t === 'voice.instruction.budget_overflow')).toHaveLength(2);

    const atRiskCall = emit.mock.calls.find((c) => c[0].type === 'voice.instruction.budget_at_risk')![0];
    expect(atRiskCall.status).toBe('warning');
    expect(atRiskCall.payload).toMatchObject({ user_id: 'a', pct_of_cap: 75 });

    const overflowCall = emit.mock.calls.find((c) => c[0].type === 'voice.instruction.budget_overflow')![0];
    expect(overflowCall.status).toBe('error');
  });

  it('emits nothing when no user is at risk', async () => {
    mockFetch.mockResolvedValue([]);
    const emit = jest.fn();
    const res = await runVoiceInstructionBudgetWatch({ supabase, emit });
    expect(res).toEqual({ scanned: 0, atRisk: 0, overflow: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('continues the scan when a single emit throws', async () => {
    mockFetch.mockResolvedValue([
      { user_id: 'a', vitana_id: '@a', display_name: 'A', memory_items: 1, memory_chars: 9_000, memory_facts: 1, pct_of_cap: 75, severity: 'at_risk' },
      { user_id: 'b', vitana_id: '@b', display_name: 'B', memory_items: 1, memory_chars: 24_000, memory_facts: 1, pct_of_cap: 200, severity: 'overflow' },
    ]);
    const emit = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ ok: true });
    const res = await runVoiceInstructionBudgetWatch({ supabase, emit });
    expect(res.scanned).toBe(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('msUntilNextUtcHour (Phase D)', () => {
  it('schedules later today when the hour is still ahead', () => {
    const now = new Date('2026-05-30T01:00:00Z');
    expect(msUntilNextUtcHour(3, now)).toBe(2 * 60 * 60 * 1000);
  });

  it('rolls to tomorrow when the hour has passed', () => {
    const now = new Date('2026-05-30T05:00:00Z');
    expect(msUntilNextUtcHour(3, now)).toBe(22 * 60 * 60 * 1000);
  });
});
