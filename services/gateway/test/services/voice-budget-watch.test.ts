import {
  BUDGET_CAP_CHARS,
  AT_RISK_PCT,
  OVERFLOW_PCT,
  computePctOfCap,
  classifyBudget,
  toVoiceBudgetRow,
  fetchVoiceBudgetWatch,
} from '../../src/services/voice-budget-watch';

describe('voice budget watch — pure helpers (Phase D)', () => {
  it('cap matches the Phase A bootstrap cap (12 KB)', () => {
    expect(BUDGET_CAP_CHARS).toBe(12_000);
  });

  it('computePctOfCap returns one-decimal percentage of the cap', () => {
    expect(computePctOfCap(12_000)).toBe(100);
    expect(computePctOfCap(6_000)).toBe(50);
    expect(computePctOfCap(2_112)).toBe(17.6); // dragan3-ish after pruning
    expect(computePctOfCap(22_800)).toBe(190); // dragan1-ish (over cap)
    expect(computePctOfCap(0)).toBe(0);
  });

  it('classifyBudget buckets by threshold', () => {
    expect(classifyBudget(0)).toBe('ok');
    expect(classifyBudget(AT_RISK_PCT - 0.1)).toBe('ok');
    expect(classifyBudget(AT_RISK_PCT)).toBe('at_risk');
    expect(classifyBudget(99.9)).toBe('at_risk');
    expect(classifyBudget(OVERFLOW_PCT)).toBe('overflow');
    expect(classifyBudget(190)).toBe('overflow');
  });

  it('toVoiceBudgetRow coerces driver types and derives severity', () => {
    const row = toVoiceBudgetRow({
      user_id: 'u1',
      vitana_id: '@dragan1',
      display_name: 'Dragan Alexander',
      memory_items: '200',
      memory_chars: '22800',
      memory_facts: 200,
      pct_of_cap: '190.0',
    });
    expect(row).toEqual({
      user_id: 'u1',
      vitana_id: '@dragan1',
      display_name: 'Dragan Alexander',
      memory_items: 200,
      memory_chars: 22800,
      memory_facts: 200,
      pct_of_cap: 190,
      severity: 'overflow',
    });
  });

  it('toVoiceBudgetRow derives pct when SQL omits it, and tolerates nulls', () => {
    const row = toVoiceBudgetRow({ user_id: 'u2', memory_chars: 6_000 });
    expect(row.pct_of_cap).toBe(50);
    expect(row.severity).toBe('ok');
    expect(row.vitana_id).toBeNull();
    expect(row.display_name).toBeNull();
    expect(row.memory_items).toBe(0);
    expect(row.memory_facts).toBe(0);
  });
});

describe('fetchVoiceBudgetWatch — query plumbing (Phase D)', () => {
  it('clamps limit, passes cap + minPct, and maps rows', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { user_id: 'a', memory_chars: 22_800, memory_items: 200, memory_facts: 50, pct_of_cap: 190 },
        { user_id: 'b', memory_chars: 2_112, memory_items: 30, memory_facts: 5, pct_of_cap: 17.6 },
      ],
      error: null,
    });
    const supabase = { rpc } as unknown as Parameters<typeof fetchVoiceBudgetWatch>[0];

    const rows = await fetchVoiceBudgetWatch(supabase, { limit: 9999, minPct: 10 });

    expect(rpc).toHaveBeenCalledWith('exec_sql', expect.objectContaining({
      params: [12_000, 10, 500], // limit clamped to 500, cap + minPct passed through
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0].severity).toBe('overflow');
    expect(rows[1].severity).toBe('ok');
  });

  it('throws a descriptive error when the query fails', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const supabase = { rpc } as unknown as Parameters<typeof fetchVoiceBudgetWatch>[0];
    await expect(fetchVoiceBudgetWatch(supabase)).rejects.toThrow(/boom/);
  });
});
