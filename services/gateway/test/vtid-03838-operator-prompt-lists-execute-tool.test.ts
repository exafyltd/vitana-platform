/**
 * VTID-03838: the operator system prompt must list autopilot_execute_task.
 *
 * VTID-03820 added the tool to GEMINI_TOOL_DEFINITIONS (the wire schema) but
 * never to the prose tool list in the operator system prompt. Observed on
 * staging (2026-09-12, thread 300fe2c1-…): with OPERATOR_EXECUTION_ONRAMP_ENABLED
 * live and the tool on the wire, DeepSeek answered "that tool isn't available
 * to me — the only autopilot capability I have here is autopilot_get_status"
 * twice, and OASIS recorded no governance.evaluate for
 * operator.autopilot.execute_task. The model was reading the prompt's list,
 * not the schema. This pins both prompt sources (the served
 * PERSONALITY_DEFAULTS copy and the inline fallback) so they cannot drift
 * apart from the declarations again.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../src/services');
const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');
const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');

function operatorChatPrompt(): string {
  const start = personality.indexOf('operator_chat: {');
  const end = personality.indexOf('calculation_directive:', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return personality.slice(start, end);
}

function inlineFallbackPrompt(): string {
  const start = operator.indexOf('function getOperatorSystemPrompt()');
  const end = operator.indexOf('if (opConfig.calculation_directive)', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return operator.slice(start, end);
}

describe('VTID-03838: operator prompt lists autopilot_execute_task', () => {
  it('is declared as a tool (VTID-03820) — the precondition this test exists for', () => {
    expect(operator).toContain("name: 'autopilot_execute_task'");
  });

  for (const [label, prompt] of [
    ['PERSONALITY_DEFAULTS.operator_chat.system_prompt (served)', operatorChatPrompt],
    ['getOperatorSystemPrompt() inline fallback', inlineFallbackPrompt],
  ] as const) {
    describe(label, () => {
      it('lists autopilot_execute_task under Available tools', () => {
        const text = prompt();
        const tools = text.slice(text.indexOf('**Available tools'), text.indexOf('**When to use tools:**'));
        expect(tools).toContain('autopilot_execute_task:');
        expect(tools).toMatch(/ALREADY-APPROVED VTID/);
      });

      it('routes explicit execution requests to autopilot_execute_task', () => {
        const text = prompt();
        const when = text.slice(text.indexOf('**When to use tools:**'), text.indexOf('**CRITICAL EXECUTION RULES'));
        expect(when).toMatch(/Execution requests naming a specific VTID[^\n]*→ call autopilot_execute_task/);
      });

      it('tells the model a ledger status of in_progress is not a running execution', () => {
        const text = prompt();
        expect(text).toContain('**CRITICAL EXECUTION RULES (autopilot_execute_task):**');
        expect(text).toMatch(/in_progress[^\n]*NOT a signal that an execution is already running/);
        expect(text).toMatch(/Do NOT refuse to execute because autopilot_get_status reports in_progress/);
      });

      it('forbids the exact failure observed live: declaring the tool unavailable without calling it', () => {
        expect(prompt()).toMatch(/call it anyway and report what it returns/);
      });

      it('keeps the guardrails: named VTID only, never speculative, honest on rejection', () => {
        const text = prompt();
        expect(text).toMatch(/SPECIFIC VTID they name/);
        expect(text).toMatch(/never use it to create new work/);
        expect(text).toMatch(/Never claim an execution was queued unless the tool returned status "queued"/);
      });
    });
  }

  it('the two prompt sources carry the same execution-rules block (no drift)', () => {
    const extract = (text: string) => {
      const start = text.indexOf('**CRITICAL EXECUTION RULES');
      const end = text.indexOf('**CRITICAL TASK CREATION RULES:**', start);
      // Normalise the served copy's JS-string escapes so the two are comparable.
      return text.slice(start, end).replace(/\\n/g, '\n').replace(/\\'/g, "'").trim();
    };
    expect(extract(operatorChatPrompt())).toBe(extract(inlineFallbackPrompt()));
  });
});
