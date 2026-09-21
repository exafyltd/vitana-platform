/**
 * VTID-04244 — a fix round is budgeted at least AGENT_FIX_ROUND_MIN_TURNS
 * turns regardless of how many the first round consumed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_FIX_ROUND_MIN_TURNS, fixRoundTurnBudget, resolveFixRoundMinTurns } from '../src/services/autopilot-agent/fix-round-budget';

describe('VTID-04244 fixRoundTurnBudget', () => {
  it('round 0 keeps the full cap', () => {
    expect(fixRoundTurnBudget(0, 120, 0)).toBe(120);
    expect(fixRoundTurnBudget(0, 60, 0)).toBe(60);
  });

  it('a later round gets the floor when the first round consumed nearly everything (the live 2-turn case)', () => {
    expect(fixRoundTurnBudget(1, 120, 118)).toBe(DEFAULT_FIX_ROUND_MIN_TURNS);
    expect(fixRoundTurnBudget(1, 120, 120)).toBe(DEFAULT_FIX_ROUND_MIN_TURNS);
    expect(fixRoundTurnBudget(2, 120, 135)).toBe(DEFAULT_FIX_ROUND_MIN_TURNS);
  });

  it('a later round keeps the larger remaining budget when plenty is left', () => {
    expect(fixRoundTurnBudget(1, 120, 40)).toBe(80);
    expect(fixRoundTurnBudget(1, 120, 100, 15)).toBe(20);
  });

  it('honours a custom floor and never returns zero for round 0', () => {
    expect(fixRoundTurnBudget(1, 120, 119, 30)).toBe(30);
    expect(fixRoundTurnBudget(0, 120, 120)).toBe(1);
  });

  it('resolveFixRoundMinTurns reads AGENT_FIX_ROUND_MIN_TURNS and falls back on garbage', () => {
    expect(resolveFixRoundMinTurns({ AGENT_FIX_ROUND_MIN_TURNS: '25' } as NodeJS.ProcessEnv)).toBe(25);
    expect(resolveFixRoundMinTurns({ AGENT_FIX_ROUND_MIN_TURNS: 'lots' } as NodeJS.ProcessEnv)).toBe(DEFAULT_FIX_ROUND_MIN_TURNS);
    expect(resolveFixRoundMinTurns({ AGENT_FIX_ROUND_MIN_TURNS: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_FIX_ROUND_MIN_TURNS);
    expect(resolveFixRoundMinTurns({} as NodeJS.ProcessEnv)).toBe(DEFAULT_FIX_ROUND_MIN_TURNS);
  });
});

describe('VTID-04244 runner wiring (source contract)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');

  it('the fix-round loop budgets each round through fixRoundTurnBudget, not the bare subtraction', () => {
    expect(src).toMatch(/maxTurns: fixRoundTurnBudget\(round, AGENT_MAX_TURNS, totalTurns, AGENT_FIX_ROUND_MIN_TURNS\)/);
    expect(src).not.toMatch(/maxTurns: AGENT_MAX_TURNS - totalTurns/);
    expect(src).toMatch(/const AGENT_FIX_ROUND_MIN_TURNS = resolveFixRoundMinTurns\(\);/);
  });
});
