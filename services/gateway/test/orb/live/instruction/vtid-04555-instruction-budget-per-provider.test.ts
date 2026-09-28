/**
 * VTID-04555 — the instruction budget follows the upstream provider.
 *
 * Staging, 2026-09-25: the static scaffold alone was 32,919 B, over the 30 KB
 * Vertex setup budget that was applied to Nova too, so the brain bootstrap
 * (12,072 B — the member's memory) was dropped from every authenticated Nova
 * session and a new session said it knew nothing the member had told it.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  enforceInstructionBudget,
  INSTRUCTION_TOTAL_BYTE_BUDGET,
  NOVA_INSTRUCTION_BYTE_BUDGET_DEFAULT,
  NOVA_INSTRUCTION_BYTE_BUDGET_ENV,
  resolveInstructionByteBudgetFor,
} from '../../../../src/orb/live/instruction/instruction-budget';

describe('resolveInstructionByteBudgetFor', () => {
  it('keeps the 30 KB Vertex budget for vertex and for unknown providers', () => {
    expect(resolveInstructionByteBudgetFor('vertex', {})).toBe(INSTRUCTION_TOTAL_BYTE_BUDGET);
    expect(resolveInstructionByteBudgetFor(undefined, {})).toBe(INSTRUCTION_TOTAL_BYTE_BUDGET);
    expect(resolveInstructionByteBudgetFor('livekit', {})).toBe(INSTRUCTION_TOTAL_BYTE_BUDGET);
  });
  it('gives Nova and the cascade 64 KB', () => {
    expect(resolveInstructionByteBudgetFor('nova_sonic', {})).toBe(65_536);
    expect(NOVA_INSTRUCTION_BYTE_BUDGET_DEFAULT).toBe(65_536);
    expect(resolveInstructionByteBudgetFor('cascaded', {})).toBe(65_536);
  });
  it('lets the env override Nova upward but never below the Vertex floor', () => {
    expect(resolveInstructionByteBudgetFor('nova_sonic', { [NOVA_INSTRUCTION_BYTE_BUDGET_ENV]: '98304' })).toBe(98_304);
    expect(resolveInstructionByteBudgetFor('nova_sonic', { [NOVA_INSTRUCTION_BYTE_BUDGET_ENV]: '1000' })).toBe(65_536);
    expect(resolveInstructionByteBudgetFor('nova_sonic', { [NOVA_INSTRUCTION_BYTE_BUDGET_ENV]: 'abc' })).toBe(65_536);
  });
});

describe('the measured staging session', () => {
  const scaffold = { kind: 'scaffold' as const, text: 'S'.repeat(32_919) };
  const bootstrap = { kind: 'bootstrap' as const, text: 'M'.repeat(12_072) };

  it('dropped the memory bootstrap under the Vertex budget (the defect)', () => {
    const r = enforceInstructionBudget([scaffold, bootstrap], resolveInstructionByteBudgetFor('vertex', {}));
    expect(r.trimmedSections).toEqual(['bootstrap']);
    expect(r.text).not.toContain('MMMM');
  });

  it('keeps the memory bootstrap on Nova', () => {
    const r = enforceInstructionBudget([scaffold, bootstrap], resolveInstructionByteBudgetFor('nova_sonic', {}));
    expect(r.trimmedSections).toEqual([]);
    expect(r.text).toContain('M'.repeat(12_072));
  });
});

describe('orb-live wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
  it('enforces the budget of the serving provider, and reports that budget', () => {
    expect(src).toMatch(/const instructionBudget = resolveInstructionByteBudgetFor\(session\.upstreamProvider\);/);
    expect(src).toMatch(/enforceInstructionBudget\(sections, instructionBudget\)/);
    expect(src).toMatch(/instructionBudgetDiagPayload\(budgetResult, instructionBudget\)/);
  });
});
