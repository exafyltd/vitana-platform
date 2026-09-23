/**
 * VTID-04394 — progress ledger + stall detection (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3, §5 P4).
 *
 * AC-1 a turn is progress when it edits, passes a check, or makes a call not
 *      made before in the run; exact repeats and failures are not progress.
 * AC-2 after `replanAfter` idle turns the loop gets ONE re-plan prompt; at
 *      `stopAfter` it stops with stalled: true and an `agent stalled` error.
 * AC-3 exploration never stalls: reading new files/ranges keeps progressing.
 * AC-4 progress after the re-plan resets the idle count; stall: false turns
 *      detection off (the turn cap still applies).
 * AC-5 a stalled run trips the VTID-04243 retry breaker like a turn-cap exit.
 */

import { ProgressLedger, REPLAN_PROMPT, callSignature } from '../src/services/autopilot-agent/agent-progress';
import { runAgentLoop } from '../src/services/autopilot-agent/agent-loop';
import { isTurnCapFailure } from '../src/services/dev-autopilot-retry-breaker';

describe('ProgressLedger (AC-1)', () => {
  test('signatures ignore argument order', () => {
    expect(callSignature('read_file', { path: 'a', start_line: 1 })).toBe(callSignature('read_file', { start_line: 1, path: 'a' }));
  });

  test('new call is progress, exact repeat is not, failed call is not', () => {
    const l = new ProgressLedger({ replanAfter: 5, stopAfter: 9 });
    expect(l.record(1, [{ name: 'read_file', args: { path: 'a' } }])).toBe('progress');
    expect(l.record(2, [{ name: 'read_file', args: { path: 'a' } }])).toBe('no_progress');
    expect(l.record(3, [{ name: 'read_file', args: { path: 'b' }, isError: true }])).toBe('no_progress');
    expect(l.idleTurns).toBe(2);
  });

  test('an edit or a passing check is progress even when repeated', () => {
    const l = new ProgressLedger({ replanAfter: 5, stopAfter: 9 });
    l.record(1, [{ name: 'edit_file', args: { path: 'a' } }]);
    expect(l.record(2, [{ name: 'edit_file', args: { path: 'a' } }])).toBe('progress');
    l.record(3, [{ name: 'run_check', args: { kind: 'tsc' }, passedCheck: true }]);
    expect(l.record(4, [{ name: 'run_check', args: { kind: 'tsc' }, passedCheck: true }])).toBe('progress');
    expect(l.record(5, [{ name: 'run_check', args: { kind: 'tsc' }, isError: true }])).toBe('no_progress');
  });
});

describe('ledger thresholds (AC-2, AC-4)', () => {
  const same = [{ name: 'search_text', args: { pattern: 'x' } }];

  test('replan exactly once, then stalled', () => {
    const l = new ProgressLedger({ replanAfter: 2, stopAfter: 4 });
    expect(l.record(1, same)).toBe('progress');
    expect(l.record(2, same)).toBe('no_progress');
    expect(l.record(3, same)).toBe('replan');
    expect(l.record(4, same)).toBe('no_progress');
    expect(l.record(5, same)).toBe('stalled');
  });

  test('progress after the re-plan resets the count', () => {
    const l = new ProgressLedger({ replanAfter: 2, stopAfter: 4 });
    l.record(1, same); l.record(2, same); expect(l.record(3, same)).toBe('replan');
    expect(l.record(4, [{ name: 'read_file', args: { path: 'new' } }])).toBe('progress');
    expect(l.idleTurns).toBe(0);
    l.record(5, same); l.record(6, same); l.record(7, same);
    expect(l.record(8, same)).toBe('stalled');
  });
});

function loopWith(callFor: (turn: number) => { name: string; arguments: Record<string, unknown> }, opts: Record<string, unknown> = {}) {
  let turn = 0;
  const prompts: string[] = [];
  return {
    prompts,
    run: () => runAgentLoop({
      systemPrompt: 's',
      prompt: 'p',
      tools: [],
      maxTurns: 40,
      execute: async (name: string) => ({ result: `ok ${name}`, isError: false }) as any,
      callLlm: async (prompt: string) => {
        prompts.push(prompt);
        turn++;
        return { ok: true, text: '', toolCalls: [{ id: `c${turn}`, ...callFor(turn) }], provider: 'deepseek', model: 'deepseek-flash' } as any;
      },
      ...opts,
    } as any),
  };
}

describe('runAgentLoop wiring (AC-2, AC-3, AC-4)', () => {
  test('a model repeating one call is re-planned once, then stopped as stalled', async () => {
    const t = loopWith(() => ({ name: 'search_text', arguments: { pattern: 'renderCiEvidence' } }), { stall: { replanAfter: 3, stopAfter: 6 } });
    const r = await t.run();
    expect(r).toMatchObject({ ok: false, stalled: true });
    expect(r.error).toMatch(/agent stalled: 6 turns without progress/);
    expect(r.turns).toBe(7);
    expect(t.prompts.filter((p) => p === REPLAN_PROMPT)).toHaveLength(1);
  });

  test('reading a new file every turn never stalls (turn cap instead)', async () => {
    const t = loopWith((n) => ({ name: 'read_file', arguments: { path: `f${n}.ts` } }), { maxTurns: 15, stall: { replanAfter: 3, stopAfter: 6 } });
    const r = await t.run();
    expect(r.stalled).toBeUndefined();
    expect(r.error).toMatch(/turn cap/);
  });

  test('stall: false disables detection', async () => {
    const t = loopWith(() => ({ name: 'search_text', arguments: { pattern: 'x' } }), { maxTurns: 12, stall: false });
    const r = await t.run();
    expect(r.stalled).toBeUndefined();
    expect(r.error).toMatch(/turn cap/);
  });
});

describe('retry breaker (AC-5)', () => {
  test('a stalled run counts like a turn-cap failure', () => {
    expect(isTurnCapFailure({ error: 'agent stalled: 10 turns without progress (repeated tool calls)' })).toBe(true);
    expect(isTurnCapFailure({ error: 'agent hit the 120-turn cap without calling finish' })).toBe(true);
    expect(isTurnCapFailure({ error: 'tsc failed' })).toBe(false);
  });
});
