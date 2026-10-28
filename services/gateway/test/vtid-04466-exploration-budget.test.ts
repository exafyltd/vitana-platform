/**
 * VTID-04466 — exploration budget + starting map for the agent executor.
 *
 * AC-1 thresholds: commit 35%, hand-off 80%, stop 90% of maxTurns; none for
 *      loops shorter than 30 turns.
 * AC-2 a run that has not edited gets the commit nudge and the hand-off
 *      instruction once each, then stops with `explorationExhausted` and an
 *      `exploration budget` error — which trips the VTID-04243 breaker.
 * AC-3 a run that edits before the stop point is never stopped by the budget;
 *      without the option the loop behaves exactly as before (turn cap).
 * AC-4 a hand-off finish (no edits) ends the loop ok with the findings.
 * AC-5 the starting map is the index answer for the task text + files, and
 *      empty when there is no index or no match.
 * AC-6 the runner wires both: starting map on non-fix runs, budget on round 0
 *      of non-fix runs only, and a hand-off's findings on the empty-diff error.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ExplorationBudget, buildHandoffPrompt, buildStartingMap, explorationStopError, explorationThresholds, startingMapQuery,
} from '../src/services/autopilot-agent/agent-exploration';
import { runAgentLoop } from '../src/services/autopilot-agent/agent-loop';
import { REPLAN_PROMPT } from '../src/services/autopilot-agent/agent-progress';
import { isTurnCapFailure } from '../src/services/dev-autopilot-retry-breaker';
import { assembleBundle } from '../src/services/codeintel-index';

describe('explorationThresholds (AC-1)', () => {
  test('120-turn runner cap → 42 / 96 / 108', () => {
    expect(explorationThresholds(120)).toEqual({ commitAt: 42, handoffAt: 96, stopAt: 108 });
  });
  test('60-turn default → 21 / 48 / 54', () => {
    expect(explorationThresholds(60)).toEqual({ commitAt: 21, handoffAt: 48, stopAt: 54 });
  });
  test('short loops (fix rounds) get no budget', () => {
    expect(explorationThresholds(15)).toBeNull();
    expect(explorationThresholds(29)).toBeNull();
    expect(explorationThresholds(Number.NaN)).toBeNull();
  });
  test('stop always leaves the last turn and sits after the hand-off', () => {
    for (const n of [30, 40, 60, 90, 120, 200]) {
      const t = explorationThresholds(n)!;
      expect(t.commitAt).toBeLessThan(t.handoffAt);
      expect(t.handoffAt).toBeLessThan(t.stopAt);
      expect(t.stopAt).toBeLessThan(n);
    }
  });
});

describe('ExplorationBudget (AC-2, AC-3)', () => {
  test('commit and hand-off fire once each once delivered, then stop', () => {
    const b = new ExplorationBudget({ commitAt: 3, handoffAt: 5, stopAt: 7 });
    expect([1, 2].map((t) => b.record(t, false))).toEqual(['continue', 'continue']);
    expect(b.record(3, false)).toBe('commit');
    b.delivered('commit');
    expect(b.record(4, false)).toBe('continue');
    expect(b.record(5, false)).toBe('handoff');
    b.delivered('handoff');
    expect(b.record(6, false)).toBe('continue');
    expect(b.record(7, false)).toBe('stop');
  });
  test('an undelivered nudge repeats on the next turn; a hand-off supersedes a pending commit', () => {
    const b = new ExplorationBudget({ commitAt: 3, handoffAt: 5, stopAt: 7 });
    expect(b.record(3, false)).toBe('commit');
    expect(b.record(4, false)).toBe('commit');
    expect(b.record(5, false)).toBe('handoff');
    b.delivered('handoff');
    expect(b.record(6, false)).toBe('continue');
  });
  test('an edit disarms the budget for the rest of the run', () => {
    const b = new ExplorationBudget({ commitAt: 3, handoffAt: 5, stopAt: 7 });
    b.record(3, false); b.delivered('commit');
    expect(b.record(4, true)).toBe('continue');
    expect(b.record(9, true)).toBe('continue');
  });
  test('the stop error trips the retry breaker like a turn-cap exit', () => {
    expect(isTurnCapFailure({ error: explorationStopError(108) })).toBe(true);
  });
});

function scriptedLoop(callFor: (turn: number) => { name: string; arguments: Record<string, unknown> }, opts: Record<string, unknown> = {}) {
  let turn = 0;
  const prompts: string[] = [];
  const run = () => runAgentLoop({
    systemPrompt: 's',
    prompt: 'p',
    tools: [],
    maxTurns: 60,
    stall: false,
    execute: async (name: string, args: Record<string, unknown>) => (name === 'finish'
      ? { result: 'finished', finished: { summary: String(args.summary), pr_title: 't', pr_body: 'b' } }
      : { result: `ok ${name}`, isError: false }) as any,
    callLlm: async (prompt: string) => {
      prompts.push(prompt);
      turn++;
      return { ok: true, text: '', toolCalls: [{ id: `c${turn}`, ...callFor(turn) }], provider: 'deepseek', model: 'deepseek-flash' } as any;
    },
    ...opts,
  } as any);
  return { prompts, run };
}

describe('runAgentLoop with an exploration budget (AC-2, AC-3, AC-4)', () => {
  const read = (t: number) => ({ name: 'read_file', arguments: { path: `f${t}.ts` } });

  test('a run that never edits is nudged, handed off, then stopped at 90%', async () => {
    const { prompts, run } = scriptedLoop(read, { exploration: explorationThresholds(60) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.explorationExhausted).toBe(true);
    expect(r.turns).toBe(54);
    expect(r.error).toBe(explorationStopError(54));
    // prompts[n] is the prompt sent on turn n+1, i.e. the answer to turn n.
    expect(prompts[21]).toContain('have used 21 of 60 turns and have not changed any file');
    expect(prompts[48]).toBe(buildHandoffPrompt(48, 60));
    expect(prompts.filter((p) => p.includes('Do not explore further')).length).toBe(1);
  });

  test('a run that edits late (turn 50) is not stopped and reaches finish', async () => {
    const { run } = scriptedLoop((t) => (t === 50 ? { name: 'edit_file', arguments: { path: 'a.ts' } }
      : t === 56 ? { name: 'finish', arguments: { summary: 'done' } } : read(t)), { exploration: explorationThresholds(60) });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.finished?.summary).toBe('done');
    expect(r.explorationExhausted).toBeUndefined();
  });

  test('a hand-off finish with no edits ends ok and carries the findings', async () => {
    const { run } = scriptedLoop((t) => (t === 49 ? { name: 'finish', arguments: { summary: 'change goes in x.ts::foo' } } : read(t)), { exploration: explorationThresholds(60) });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.finished?.summary).toBe('change goes in x.ts::foo');
  });

  test('without the option the loop runs to the turn cap exactly as before', async () => {
    const { prompts, run } = scriptedLoop(read);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.explorationExhausted).toBeUndefined();
    expect(r.error).toBe('agent hit the 60-turn cap without calling finish');
    expect(prompts.some((p) => p.includes('have not changed any file'))).toBe(false);
  });

  test('the stall ledger keeps priority over the budget on the same turn', async () => {
    const { prompts, run } = scriptedLoop(() => ({ name: 'search_text', arguments: { pattern: 'x' } }), {
      stall: { replanAfter: 3, stopAfter: 50 },
      exploration: { commitAt: 4, handoffAt: 20, stopAt: 30 },
    });
    await run();
    // idle turns 2,3,4 → replan on turn 4 wins over the commit nudge due on turn 4
    expect(prompts[4]).toBe(REPLAN_PROMPT);
    expect(prompts[5]).toContain('have not changed any file');
  });
});

describe('starting map (AC-5)', () => {
  const manifest = { format: 1, repo: 'exafyltd/vitana-platform', sha: 'deadbeef', built_at: 'now', files: { graph: 'g', risk: 'r' }, counts: {} } as any;
  const graph = {
    format: 1,
    relations: ['contains', 'calls'],
    nodes: [
      ['n1', 'renderCiEvidence()', 'code', 'services/gateway/src/services/dev-autopilot-ci-logs.ts', 'L10', 'function'],
      ['n2', 'dev-autopilot-watcher.ts', 'code', 'services/gateway/src/services/dev-autopilot-watcher.ts', 'L1', 'file'],
    ],
    edges: [['n2', 'n1', 1]],
  } as any;
  const risk = { format: 1, files: {}, hotspots: {}, dead_code: {}, decisions: [] } as any;
  const bundle = assembleBundle(manifest, graph, risk);

  test('query uses the referenced files and the task text without markdown noise', () => {
    const q = startingMapQuery('## Goal\n- make **renderCiEvidence** report the total\nVTID: VTID-1', ['a.ts', 'b.ts']);
    expect(q.startsWith('a.ts b.ts')).toBe(true);
    expect(q).toContain('make **renderCiEvidence** report the total');
    expect(q).not.toContain('VTID-1');
  });

  test('builds a prompt section from the index answer', () => {
    const m = buildStartingMap(bundle, 'Change renderCiEvidence to report the total failing count', []);
    expect(m).toContain('## Starting map');
    expect(m).toContain('renderCiEvidence');
  });

  test('empty without an index or a match', () => {
    expect(buildStartingMap(null, 'anything', [])).toBe('');
    expect(buildStartingMap(bundle, '', [])).toBe('');
    expect(buildStartingMap(bundle, 'qqqqzzzz wwwwxxxx', [])).toBe('');
  });
});

describe('runner wiring (AC-6)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');

  test('starting map only on non-fix runs', () => {
    expect(src).toMatch(/if \(!fixMode\) \{\s*const startingMap = buildStartingMap\(codeIndex\.bundle/);
  });
  test('budget only on round 0 of a non-fix run, with a kill switch', () => {
    expect(src).toContain("const explorationEnabled = !fixMode && process.env.AGENT_EXPLORATION_BUDGET_ENABLED !== 'false';");
    expect(src).toContain('exploration: explorationEnabled && round === 0 ? explorationThresholds(AGENT_MAX_TURNS) : null');
  });
  test('an empty-diff finish keeps the agent findings on the error', () => {
    expect(src).toContain('refusing to open an empty PR${findings ? `. Agent findings: ${findings}` : \'\'}');
  });
});
