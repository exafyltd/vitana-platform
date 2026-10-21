/**
 * VTID-04598: the Operator Console reports the coding model an execution
 * actually runs on.
 *
 * Observed 2026-09-26 on staging: after VTID-04593 stamped Bedrock Claude
 * Sonnet 4.6 on the execution row, autopilot_run_task still returned
 * provider: 'deepseek', and the console told the owner the run was on DeepSeek.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../src/services');
const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');
const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');
const registry = fs.readFileSync(path.join(SRC, 'tool-registry.ts'), 'utf8');

function body(start: string, end: string): string {
  const i = operator.indexOf(start);
  const j = operator.indexOf(end, i + start.length);
  expect(i).toBeGreaterThan(-1);
  return operator.slice(i, j > i ? j : undefined);
}

describe('VTID-04598 on-ramp tool results name the stamped model', () => {
  it('no tool result hard-codes the DeepSeek provider', () => {
    expect(operator).not.toMatch(/provider: 'deepseek'/);
  });

  it('autopilot_execute_task and autopilot_run_task report devWorkerModel()', () => {
    const matches = operator.match(/provider: devWorkerModel\(\)\.provider,\s*model: devWorkerModel\(\)\.model,/g) || [];
    expect(matches.length).toBe(2);
    expect(operator).toContain("import { devWorkerModel } from './dev-pipeline-models';");
  });

  it('the on-ramp is no longer described as DeepSeek-powered to the model', () => {
    for (const text of [operator, personality, registry]) {
      expect(text).not.toMatch(/DeepSeek-powered execution on-ramp|DeepSeek execution on-ramp/);
    }
    expect(body('function getOperatorSystemPrompt()', 'if (opConfig.calculation_directive)'))
      .toContain('autopilot_execute_task: Execute an ALREADY-APPROVED VTID via the execution on-ramp');
  });
});
