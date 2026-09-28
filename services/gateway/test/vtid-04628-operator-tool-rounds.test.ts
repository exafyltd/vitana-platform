/**
 * VTID-04628: the Operator Console runs several rounds of tools per turn.
 * The end-to-end behaviour is pinned in the operator regression suite
 * (test/vtid-04465-operator-pipeline-regression.test.ts, "Console turn: several
 * rounds of tools"); this file pins the helpers.
 */
import { clipToolResultForTranscript, operatorMaxToolRounds, OPERATOR_CONTINUE_PROMPT } from '../src/services/gemini-operator';

describe('operatorMaxToolRounds', () => {
  it('defaults to 4, honours 1..10, clamps above 10, ignores garbage', () => {
    expect(operatorMaxToolRounds({} as NodeJS.ProcessEnv)).toBe(4);
    expect(operatorMaxToolRounds({ OPERATOR_MAX_TOOL_ROUNDS: '1' } as NodeJS.ProcessEnv)).toBe(1);
    expect(operatorMaxToolRounds({ OPERATOR_MAX_TOOL_ROUNDS: '7' } as NodeJS.ProcessEnv)).toBe(7);
    expect(operatorMaxToolRounds({ OPERATOR_MAX_TOOL_ROUNDS: '50' } as NodeJS.ProcessEnv)).toBe(10);
    expect(operatorMaxToolRounds({ OPERATOR_MAX_TOOL_ROUNDS: '0' } as NodeJS.ProcessEnv)).toBe(4);
    expect(operatorMaxToolRounds({ OPERATOR_MAX_TOOL_ROUNDS: 'x' } as NodeJS.ProcessEnv)).toBe(4);
  });
});

describe('clipToolResultForTranscript', () => {
  it('passes a tool result to the next round as JSON, including the error text', () => {
    const s = clipToolResultForTranscript({ ok: false, error: 'column "id" does not exist' });
    expect(JSON.parse(s)).toEqual({ ok: false, error: 'column "id" does not exist' });
  });
  it('bounds a large result', () => {
    const s = clipToolResultForTranscript({ rows: 'x'.repeat(50_000) });
    expect(s.length).toBeLessThanOrEqual(12_000 + '…[truncated]'.length);
    expect(s.endsWith('…[truncated]')).toBe(true);
  });
});

describe('the continuation prompt', () => {
  it('asks for a corrected retry and forbids claiming a tool ran without a result', () => {
    expect(OPERATOR_CONTINUE_PROMPT).toMatch(/call the tools again with corrected arguments/);
    expect(OPERATOR_CONTINUE_PROMPT).toMatch(/Never claim a tool ran unless its result is above/);
  });
});
