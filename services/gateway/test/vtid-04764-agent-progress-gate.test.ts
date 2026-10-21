/**
 * VTID-04764: Jev P1 gate A1 — the Dev Autopilot agent progress check.
 * The loop hook is observe-only; the gate asks Jev every N turns in shadow
 * and writes agreement back from the run's real outcome.
 */
const rows: any[] = [];
const outcomes: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push(row);
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { createAgentProgressGate, agentProgressEvery } from '../src/services/jev/gates/agent-progress-gate';
import { runAgentLoop, type AgentTurnSnapshot } from '../src/services/autopilot-agent/agent-loop';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const sb = {} as any;

function jevAnswer(next: string, conf = 0.9, finish = 0.2) {
  return {
    ok: true,
    model: 'jev-1.13.0',
    answers: {
      next_step: { type: 'choice', choice: next, probabilities: { [next]: conf }, confidence: conf },
      will_finish: { type: 'noul', noul: finish },
    },
    usage: { input_tokens: 900, output_tokens: 2 },
    latency_ms: 30,
    attempts: 1,
  };
}

function snap(turn: number, extra: Partial<AgentTurnSnapshot> = {}): AgentTurnSnapshot {
  return {
    turn,
    maxTurns: 120,
    toolCalls: turn * 2,
    hasEdited: turn > 5,
    idleTurns: 0,
    loopAction: 'continue',
    calls: [{ name: 'read_file', path: `src/f${turn}.ts` }, { name: 'run_check', isError: turn % 2 === 0, passedCheck: turn % 2 === 1 }],
    ...extra,
  };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04764 decision', () => {
  test('agent_progress_check is telemetry on the internal planes with a 4-way choice', () => {
    const d = getJevDecision('agent_progress_check')!;
    expect(d).toBeDefined();
    expect(d.data).toBe('telemetry');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys((d.questions.next_step as any).criteria)).toEqual(['continue', 'commit', 'handoff', 'stop']);
    expect(d.input.safeParse({ task: 't', turn: 10, max_turns: 120, tool_calls: 20, has_edited: true, idle_turns: 0, failed_checks: 1, passed_checks: 0, recent_activity: ['t10 read_file ok'] }).success).toBe(true);
  });
});

describe('VTID-04764 gate', () => {
  test('off (default, or a typo): a no-op, nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [{}, { JEV_AGENT_PROGRESS_MODE: 'Shadow' }]) {
      const g = createAgentProgressGate({ executionId: 'e1', findingId: 'f1', task: 't', env, sb, decideOptions: { call } });
      for (let t = 1; t <= 30; t++) g.onTurn(snap(t));
      await g.finish('failed');
      expect(g.mode).toBe('off');
    }
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('shadow: asks every 10th turn, in order, with the activity window and check counts', async () => {
    const call = jest.fn().mockResolvedValue(jevAnswer('continue'));
    const env = { ...JEV_ON, JEV_AGENT_PROGRESS_MODE: 'shadow' };
    const g = createAgentProgressGate({ executionId: 'exec-1', findingId: 'find-1', task: 'Fix the flaky retry in X', env, sb, decideOptions: { call } });
    for (let t = 1; t <= 25; t++) g.onTurn(snap(t, t === 20 ? { loopAction: 'replan', idleTurns: 6 } : {}));
    await g.finish('pr_opened');
    expect(call).toHaveBeenCalledTimes(2);
    const state = call.mock.calls[0][0].state;
    expect(state.progress).toMatchObject({ turn: 10, max_turns: 120, turns_remaining: 110, failed_checks: 5, passed_checks: 5 });
    expect(state.recent_activity).toHaveLength(20);
    expect(state.recent_activity[0]).toBe('t1 read_file src/f1.ts ok');
    expect(rows.map((r) => [r.subject_ref, r.system_action, r.jev_verdict.turn])).toEqual([
      ['exec-1', 'continue', 10],
      ['exec-1', 'replan', 20],
    ]);
    expect(rows[0]).toMatchObject({ gate: 'agent_progress', mode: 'shadow', subject_type: 'dev_autopilot_execution', jev_outcome: 'decided', jev_verdict: { next_step: 'continue', finding_id: 'find-1' } });
  });

  test('the window keeps the last 30 calls only', async () => {
    const call = jest.fn().mockResolvedValue(jevAnswer('continue'));
    const g = createAgentProgressGate({ executionId: 'e', findingId: 'f', task: 't', env: { ...JEV_ON, JEV_AGENT_PROGRESS_MODE: 'shadow', JEV_AGENT_PROGRESS_EVERY: '20' }, sb, decideOptions: { call } });
    expect(agentProgressEvery({ JEV_AGENT_PROGRESS_EVERY: '20' })).toBe(20);
    expect(agentProgressEvery({ JEV_AGENT_PROGRESS_EVERY: '1' })).toBe(10);
    for (let t = 1; t <= 20; t++) g.onTurn(snap(t));
    await g.finish('failed');
    const recent = call.mock.calls[0][0].state.recent_activity;
    expect(recent).toHaveLength(30);
    expect(recent[0]).toBe('t6 read_file src/f6.ts ok');
  });

  test.each([
    ['continue', 'pr_opened', true],
    ['commit', 'awaiting_approval', true],
    ['continue', 'failed', false],
    ['stop', 'failed', true],
    ['handoff', 'failed', true],
    ['stop', 'pr_opened', false],
  ])('agreement: predicted %s, run %s → %s', async (next, outcome, agreed) => {
    const call = jest.fn().mockResolvedValue(jevAnswer(next));
    const g = createAgentProgressGate({ executionId: 'e', findingId: 'f', task: 't', env: { ...JEV_ON, JEV_AGENT_PROGRESS_MODE: 'shadow' }, sb, decideOptions: { call } });
    for (let t = 1; t <= 10; t++) g.onTurn(snap(t));
    await g.finish(outcome as any);
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', outcome: `run_${outcome}`, agreed })]);
  });

  test('a cancelled run, an abstention or a failed Jev call carries agreed = null', async () => {
    const env = { ...JEV_ON, JEV_AGENT_PROGRESS_MODE: 'shadow' };
    const g1 = createAgentProgressGate({ executionId: 'e', findingId: 'f', task: 't', env, sb, decideOptions: { call: jest.fn().mockResolvedValue(jevAnswer('stop')) } });
    for (let t = 1; t <= 10; t++) g1.onTurn(snap(t));
    await g1.finish('cancelled');
    const g2 = createAgentProgressGate({ executionId: 'e', findingId: 'f', task: 't', env, sb, decideOptions: { call: jest.fn().mockResolvedValue(jevAnswer('stop', 0.3)) } });
    for (let t = 1; t <= 10; t++) g2.onTurn(snap(t));
    await g2.finish('failed');
    const g3 = createAgentProgressGate({ executionId: 'e', findingId: 'f', task: 't', env, sb, decideOptions: { call: jest.fn().mockResolvedValue({ ok: false, reason: 'http_error', status: 500, error: 'x', latency_ms: 1, attempts: 1 }) } });
    for (let t = 1; t <= 10; t++) g3.onTurn(snap(t));
    await g3.finish('failed');
    expect(rows.map((r) => r.jev_outcome)).toEqual(['decided', 'abstained', 'fallback']);
    expect(outcomes.map((o) => o.agreed)).toEqual([null, null, null]);
  });

  test('a throwing Jev client never reaches the loop', async () => {
    const call = jest.fn().mockRejectedValue(new Error('boom'));
    const g = createAgentProgressGate({ executionId: 'e', findingId: 'f', task: 't', env: { ...JEV_ON, JEV_AGENT_PROGRESS_MODE: 'shadow' }, sb, decideOptions: { call } });
    expect(() => { for (let t = 1; t <= 10; t++) g.onTurn(snap(t)); }).not.toThrow();
    await expect(g.finish('failed')).resolves.toBeUndefined();
  });
});

describe('VTID-04764 loop hook (observe-only)', () => {
  const tools = [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }] as any;
  const llmTurns = (n: number) => {
    let i = 0;
    return jest.fn(async () => {
      i += 1;
      return i < n
        ? { ok: true, toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `src/a${i}.ts` } }], usage: { inputTokens: 10, outputTokens: 1 } }
        : { ok: true, toolCalls: [{ id: `c${i}`, name: 'finish', arguments: { summary: 's', pr_title: 'p', pr_body: 'b' } }], usage: { inputTokens: 10, outputTokens: 1 } };
    }) as any;
  };
  const execute = async (name: string) => (name === 'finish' ? { result: 'ok', finished: { summary: 's', pr_title: 'p', pr_body: 'b' } } : { result: 'content' });

  test('one snapshot per completed tool turn, with the loop action and the calls', async () => {
    const seen: AgentTurnSnapshot[] = [];
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools, execute: execute as any, callLlm: llmTurns(4), stall: false, onTurnSnapshot: (s) => seen.push(s) });
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.turn)).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({ maxTurns: 60, toolCalls: 1, hasEdited: false, loopAction: 'continue', calls: [{ name: 'read_file', path: 'src/a1.ts' }] });
  });

  test('a throwing hook changes nothing', async () => {
    const withHook = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools, execute: execute as any, callLlm: llmTurns(4), stall: false, onTurnSnapshot: () => { throw new Error('x'); } });
    const without = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools, execute: execute as any, callLlm: llmTurns(4), stall: false });
    expect({ ok: withHook.ok, turns: withHook.turns, toolCalls: withHook.toolCalls }).toEqual({ ok: without.ok, turns: without.turns, toolCalls: without.toolCalls });
  });
});

describe('VTID-04764 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const runner = fs.readFileSync(path.join(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');
  test('the runner feeds every loop round to the gate and closes it in finally with the run outcome', () => {
    expect(runner).toContain('onTurnSnapshot: progressGate.onTurn');
    expect(runner).toMatch(/finally \{[\s\S]*await progressGate\.finish\(run\.outcome\);/);
  });
  test('both gateways pin shadow; the ECS executor is not wired yet (its role must be able to read the key first)', () => {
    const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    const exec = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml'), 'utf8');
    for (const wf of [stage, prod]) expect(wf).toContain('{name:"JEV_AGENT_PROGRESS_MODE", value:"shadow"}');
    expect(exec).not.toMatch(/JEV_AGENT_PROGRESS_MODE|TYPESAFE_API_KEY/);
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_AGENT_PROGRESS_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
