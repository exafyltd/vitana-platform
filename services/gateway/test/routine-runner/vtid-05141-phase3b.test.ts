/**
 * VTID-05141 — Loop Engineering Phase 3b: voice-lab-triage, llm-spend-budget,
 * llm-fallback-watch checks, the voice data loader, and the runner stop rules
 * (stagnation stop, repeated-breach damping).
 */
import {
  checkLlmFallbackWatch,
  checkLlmSpendBudget,
  checkVoiceLabTriage,
  VoiceWindow,
} from '../../src/services/routine-runner/checks';
import {
  isStagnated,
  resetRoutineRunnerForTest,
  runDueRoutines,
  shouldDampBreach,
  RecentRun,
  RunnerDeps,
} from '../../src/services/routine-runner/runner';
import { RunnerRoutine } from '../../src/services/routine-runner/sources';

const win = (total: number, errors: number, classes: Record<string, number> = {}): VoiceWindow => ({
  total_sessions: total,
  error_sessions: errors,
  error_rate: total ? errors / total : null,
  by_failure_class: classes,
});

describe('checkVoiceLabTriage (routines/voice-lab-triage.md thresholds)', () => {
  const baseline = win(700, 35, { 'voice.model_stall': 20, 'voice.upstream_disconnect': 15 }); // 5%, 100/day
  it('green within baseline', () => {
    const v = checkVoiceLabTriage(win(100, 6, { 'voice.model_stall': 6 }), baseline);
    expect(v.status).toBe('success');
    expect(v.breach).toBeUndefined();
  });
  it('error-rate spike needs > 1.5x baseline AND >= 3 error sessions', () => {
    expect(checkVoiceLabTriage(win(100, 10, { 'voice.model_stall': 10 }), baseline).breach?.payload).toMatchObject({ regression_kind: 'error_rate_spike' });
    // 2 of 20 = 10% > 7.5%, but only 2 error sessions → not a spike (and 20 < 30 → collapse instead)
    const small = checkVoiceLabTriage(win(40, 2, { 'voice.model_stall': 2 }), baseline);
    expect((small.findings as any).regression_kinds).not.toContain('error_rate_spike');
  });
  it('novel failure class with >= 3 sessions', () => {
    const v = checkVoiceLabTriage(win(100, 4, { 'voice.tts_failed': 3, 'voice.model_stall': 1 }), baseline);
    expect((v.findings as any).regression_kinds).toEqual(['novel_failure_class']);
    expect(v.breach).toMatchObject({ topic: 'voice.live.regression.daily_triage', vtid: 'VTID-01155' });
  });
  it('session collapse below 30% of the baseline daily average', () => {
    const v = checkVoiceLabTriage(win(29, 0), baseline);
    expect((v.findings as any).regression_kinds).toEqual(['session_collapse']);
    expect(checkVoiceLabTriage(win(30, 0), baseline).status).toBe('success');
  });
});

describe('checkLlmSpendBudget', () => {
  const line = (scope: any, key: string, spent: number, limit: number) => ({ scope, key, spent_usd: spent, limit_usd: limit, used_pct: (spent / limit) * 100, over: spent > limit });
  it('no spend data is a failure, never green', () => {
    expect(checkLlmSpendBudget({ rows: 0, since: 's', truncated: false, lines: [line('platform', 'platform', 0, 200)] }).status).toBe('failure');
  });
  it('green under budget', () => {
    expect(checkLlmSpendBudget({ rows: 500, since: 's', truncated: false, lines: [line('platform', 'platform', 50, 200)] }).status).toBe('success');
  });
  it('over budget → partial with llm.spend.budget_exceeded', () => {
    const v = checkLlmSpendBudget({ rows: 500, since: 's', truncated: false, lines: [line('platform', 'platform', 50, 200), line('agent', 'autopilot-agent', 70, 60)] });
    expect(v.status).toBe('partial');
    expect(v.breach?.topic).toBe('llm.spend.budget_exceeded');
    expect((v.breach?.payload as any).over_budget).toHaveLength(1);
  });
});

describe('checkLlmFallbackWatch', () => {
  const call = (fallback: boolean) => ({ created_at: '2026-10-13T01:00:00Z', provider: 'vertex', model: 'gemini-2.5-pro', stage: 'worker', service: null, fallback_used: fallback });
  it('green with no Google call', () => expect(checkLlmFallbackWatch([]).status).toBe('success'));
  it('any Google landing is an incident with status error', () => {
    const v = checkLlmFallbackWatch([call(true), call(false)]);
    expect(v.status).toBe('partial');
    expect(v.breach).toMatchObject({ topic: 'llm.fallback.google_incident', status: 'error' });
    expect(v.findings).toMatchObject({ fallback_to_google: 1, routed_at_google: 1 });
  });
});

describe('stop rules', () => {
  const run = (status: string, topic?: string): RecentRun => ({ status, findings: topic ? { breach_topic: topic } : {} });
  it('damping needs the previous 3 runs to be the same breach', () => {
    expect(shouldDampBreach([run('partial', 't'), run('partial', 't'), run('partial', 't')], 't')).toBe(true);
    expect(shouldDampBreach([run('partial', 't'), run('success'), run('partial', 't')], 't')).toBe(false);
    expect(shouldDampBreach([run('partial', 't'), run('partial', 'u'), run('partial', 't')], 't')).toBe(false);
    expect(shouldDampBreach([run('partial', 't'), run('partial', 't')], 't')).toBe(false);
  });
  it('stagnation needs the latest 3 runs to all be failure; partial or success in between resets it', () => {
    expect(isStagnated([run('failure'), run('failure'), run('failure')])).toBe(true);
    expect(isStagnated([run('failure'), run('partial', 't'), run('failure')])).toBe(false);
    expect(isStagnated([run('failure'), run('failure')])).toBe(false);
  });

  beforeEach(() => resetRoutineRunnerForTest());
  const at = new Date('2026-10-13T12:00:00Z');
  function deps(history: RecentRun[]) {
    const calls = { route: 0, emit: 0, stop: [] as string[], finish: [] as any[] };
    const d: RunnerDeps = {
      claim: async (n) => `run-${n}`,
      finish: async (_id, verdict) => { calls.finish.push(verdict); },
      emitBreach: async () => { calls.emit++; },
      routeBreach: async () => { calls.route++; },
      recentRuns: async () => history,
      stopStagnated: async (n) => { calls.stop.push(n); },
    };
    return { d, calls };
  }
  const r = (run: RunnerRoutine['run']): RunnerRoutine => ({ name: 'x', hour: 6, minute: 0, run });
  const breach = { topic: 't', vtid: 'V', message: 'm', payload: {} };

  it('a damped breach still emits its OASIS event but skips self-healing', async () => {
    const { d, calls } = deps([run('partial', 't'), run('partial', 't'), run('partial', 't')]);
    await runDueRoutines(d, at, [r(async () => ({ status: 'partial', summary: 's', findings: {}, breach }))]);
    expect(calls.emit).toBe(1);
    expect(calls.route).toBe(0);
    expect(calls.finish[0].findings).toMatchObject({ breach_topic: 't', self_healing_damped: true });
  });
  it('a new breach is routed and its topic recorded on the run', async () => {
    const { d, calls } = deps([run('success')]);
    await runDueRoutines(d, at, [r(async () => ({ status: 'partial', summary: 's', findings: {}, breach }))]);
    expect(calls.route).toBe(1);
    expect(calls.finish[0].findings).toEqual({ breach_topic: 't' });
  });
  it('the third crash in a row switches the routine off; a breach never does', async () => {
    const { d, calls } = deps([run('failure'), run('failure'), run('failure')]);
    await runDueRoutines(d, at, [r(async () => { throw new Error('loader down'); })]);
    expect(calls.stop).toEqual(['x']);
    resetRoutineRunnerForTest();
    const b = deps([run('failure'), run('failure'), run('failure')]);
    await runDueRoutines(b.d, at, [r(async () => ({ status: 'partial', summary: 's', findings: {}, breach }))]);
    expect(b.calls.stop).toEqual([]);
  });
  it('without the optional deps the VTID-05103 behaviour is unchanged', async () => {
    const { d, calls } = deps([]);
    delete (d as any).recentRuns;
    delete (d as any).stopStagnated;
    await runDueRoutines(d, at, [r(async () => ({ status: 'partial', summary: 's', findings: {}, breach }))]);
    expect(calls.route).toBe(1);
  });
});

describe('auditVoiceSessionOutcomes', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://supa.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
  });
  it('reads voice_session_facts in the window, ended sessions only, and counts error outcomes by failure_class', async () => {
    const urls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          { outcome: 'ok', failure_class: null },
          { outcome: 'dropped', failure_class: 'voice.upstream_disconnect' },
          { outcome: 'error', failure_class: null },
        ],
      };
    });
    const { auditVoiceSessionOutcomes } = require('../../src/routes/routine-audits');
    const res = await auditVoiceSessionOutcomes({ sinceHours: 192, untilHours: 24 });
    expect(urls[0]).toContain('/rest/v1/voice_session_facts?select=outcome,failure_class');
    expect(urls[0]).toMatch(/started_at=gte\..*&started_at=lt\./);
    expect(urls[0]).toContain('outcome=neq.active');
    expect(res).toMatchObject({ total_sessions: 3, error_sessions: 2, by_failure_class: { 'voice.upstream_disconnect': 1, 'voice.unknown': 1 } });
  });
  it('a failed read throws (the runner records a failure, never a green pass)', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const { auditVoiceSessionOutcomes } = require('../../src/routes/routine-audits');
    await expect(auditVoiceSessionOutcomes({ sinceHours: 24 })).rejects.toThrow('voice_session_facts');
  });
});
