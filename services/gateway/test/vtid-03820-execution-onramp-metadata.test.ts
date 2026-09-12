/**
 * VTID-03820: extractLlmOnRampOverride() regression tests.
 *
 * runExecutionSession() reads metadata.llm_on_ramp_override off the
 * dev_autopilot_executions row to decide whether THIS execution forces
 * DeepSeek — set only by operator-execution-onramp.ts, never by the
 * autonomous self-healing path. Must be permissive about malformed input
 * (untrusted jsonb) and never throw.
 */

import { extractLlmOnRampOverride } from '../src/services/dev-autopilot-execute';

describe('extractLlmOnRampOverride (VTID-03820)', () => {
  it('returns undefined for null/undefined metadata', () => {
    expect(extractLlmOnRampOverride(null)).toBeUndefined();
    expect(extractLlmOnRampOverride(undefined)).toBeUndefined();
  });

  it('returns undefined when the field is absent (self-healing executions)', () => {
    expect(extractLlmOnRampOverride({})).toBeUndefined();
    expect(extractLlmOnRampOverride({ some_other_field: true })).toBeUndefined();
  });

  it('returns the override when provider/model are valid', () => {
    const result = extractLlmOnRampOverride({
      llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' },
    });
    expect(result).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
  });

  it('rejects an unknown provider', () => {
    const result = extractLlmOnRampOverride({
      llm_on_ramp_override: { provider: 'not-a-real-provider', model: 'deepseek-flash' },
    });
    expect(result).toBeUndefined();
  });

  it('rejects a missing/non-string model', () => {
    expect(extractLlmOnRampOverride({ llm_on_ramp_override: { provider: 'deepseek' } })).toBeUndefined();
    expect(extractLlmOnRampOverride({ llm_on_ramp_override: { provider: 'deepseek', model: '' } })).toBeUndefined();
    expect(extractLlmOnRampOverride({ llm_on_ramp_override: { provider: 'deepseek', model: 123 } })).toBeUndefined();
  });

  it('rejects a non-object llm_on_ramp_override without throwing', () => {
    expect(extractLlmOnRampOverride({ llm_on_ramp_override: 'deepseek' })).toBeUndefined();
    expect(extractLlmOnRampOverride({ llm_on_ramp_override: null })).toBeUndefined();
    expect(extractLlmOnRampOverride({ llm_on_ramp_override: 42 })).toBeUndefined();
  });

  it('accepts every real LLMProvider value', () => {
    for (const provider of ['anthropic', 'openai', 'vertex', 'deepseek', 'claude_subscription', 'bedrock']) {
      expect(extractLlmOnRampOverride({ llm_on_ramp_override: { provider, model: 'x' } })).toEqual({ provider, model: 'x' });
    }
  });
});

describe('runExecutionSession source wiring (VTID-03820, source check)', () => {
  // runExecutionSession itself needs a live Supabase connection and isn't
  // unit-testable in isolation (same established scope limit as this
  // module's other Supabase-dependent helpers — see
  // vtid-03818-reaper-terminal-flag.test.ts). This pins the two things that
  // matter: the worker-queue path is skipped when an override is present,
  // and the override is threaded into callMessagesApi.
  const fs = require('fs');
  const path = require('path');
  const SOURCE: string = fs.readFileSync(
    path.join(__dirname, '../src/services/dev-autopilot-execute.ts'),
    'utf8'
  );

  it('computes onRampOverride from exec.metadata before choosing the LLM path', () => {
    const idx = SOURCE.indexOf('const onRampOverride = extractLlmOnRampOverride(exec.metadata);');
    expect(idx).toBeGreaterThan(-1);
  });

  it('the worker-queue branch condition excludes executions carrying an override', () => {
    expect(SOURCE).toContain('(isWorkerQueueEnabled() && !onRampOverride)');
  });

  it('the direct-API branch passes the override into callMessagesApi', () => {
    // VTID-03821: the vtid argument itself changed from a synthetic
    // per-execution id to telemetryVtid (real activated_vtid when known —
    // see vtid-03821-execution-telemetry-vtid.test.ts); this only pins
    // that the override is still threaded through as the 3rd argument.
    expect(SOURCE).toContain('await callMessagesApi(prompt, telemetryVtid, onRampOverride);');
  });
});
