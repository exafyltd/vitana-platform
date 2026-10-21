/**
 * VTID-04234 — the architecture investigator runs on the `triage` LLM
 * routing stage through callViaRouter, never a direct provider call.
 *
 * docs/AGENT-REGISTRY.md finding 1: until this VTID the investigator did a
 * bare `fetch` to api.deepseek.com with DEEPSEEK_API_KEY — no
 * llm_routing_policy, no fallback, no llm.call.* telemetry or cost, and a
 * hard `DEEPSEEK_API_KEY not set` throw on any task def without the key
 * (prod has none, so the operator's investigate_failure tool failed there).
 * These tests pin the routed shape and the source contract.
 */

const routerCalls: Array<{ stage: string; prompt: string; opts: Record<string, unknown> }> = [];
let routerResult: Record<string, unknown> = {};
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: jest.fn(async (stage: string, prompt: string, opts: Record<string, unknown>) => {
    routerCalls.push({ stage, prompt, opts });
    return routerResult;
  }),
}));

const emitted: Array<Record<string, unknown>> = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: Record<string, unknown>) => { emitted.push(e); }),
}));

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const REPORT_JSON = JSON.stringify({
  root_cause: 'the watcher polled a deleted host',
  confidence: 0.8,
  suggested_fix: 'repoint the URL',
  alternative_hypotheses: [{ hypothesis: 'token expired', confidence: 0.1, why_less_likely: 'no 401s' }],
});

function installFetch(): void {
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes('/rest/v1/oasis_events')) {
      return new Response(JSON.stringify([
        { id: 'e1', topic: 'dev_autopilot.scan.failed', vtid: 'VTID-04225', service: 'gateway', status: 'error', message: 'POST failed 404', metadata: null, created_at: '2026-09-21T10:00:00Z' },
      ]), { status: 200 });
    }
    if (String(url).includes('/rest/v1/architecture_reports')) {
      return new Response(JSON.stringify([{ id: 'rep-1' }]), { status: 201 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function loadModule(env: Record<string, string | undefined> = {}) {
  jest.resetModules();
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  delete process.env.ARCH_INVESTIGATOR_PROVIDER;
  delete process.env.ARCH_INVESTIGATOR_MODEL;
  delete process.env.DEEPSEEK_API_KEY;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return import('../src/services/architecture-investigator');
}

beforeEach(() => {
  routerCalls.length = 0;
  emitted.length = 0;
  fetchCalls.length = 0;
  routerResult = {
    ok: true,
    text: `Here is the hypothesis:\n${REPORT_JSON}`,
    provider: 'bedrock',
    model: 'eu.anthropic.claude-sonnet-4-6',
    fallbackUsed: false,
    usage: { inputTokens: 1234, outputTokens: 210 },
  };
  installFetch();
});

describe('VTID-04234: architecture investigator on the triage stage', () => {
  it('calls callViaRouter on the triage stage with the investigator system prompt and fallback allowed — no override by default', async () => {
    const m = await loadModule();
    const report = await m.investigateIncident({ incident_topic: 'dev_autopilot.scan.failed', vtid: 'VTID-04225', trigger_reason: 'manual' });

    expect(routerCalls).toHaveLength(1);
    const call = routerCalls[0];
    expect(call.stage).toBe('triage');
    expect(call.opts.service).toBe('architecture-investigator');
    expect(call.opts.vtid).toBe('VTID-04225');
    expect(call.opts.allowFallback).toBe(true);
    expect(call.opts.maxTokens).toBe(m.ARCH_INVESTIGATOR_MAX_TOKENS);
    expect(String(call.opts.systemPrompt)).toMatch(/architecture investigator/i);
    expect(call.opts.providerOverride).toBeUndefined();
    expect(call.opts.modelOverride).toBeUndefined();
    expect(call.prompt).toContain('dev_autopilot.scan.failed');
    expect(call.prompt).toContain('POST failed 404');

    expect(report.root_cause).toBe('the watcher polled a deleted host');
    expect(report.id).toBe('rep-1');
  });

  it('records the provider/model the router actually served on the report row, the event and the return value', async () => {
    routerResult = { ...routerResult, provider: 'deepseek', model: 'deepseek-chat', fallbackUsed: true };
    const m = await loadModule();
    const report = await m.investigateIncident({ incident_topic: 'x' });

    const persist = fetchCalls.find((c) => c.url.includes('/rest/v1/architecture_reports'));
    expect(persist).toBeDefined();
    const row = JSON.parse(String(persist!.init!.body));
    expect(row.llm_provider).toBe('deepseek');
    expect(row.llm_model).toBe('deepseek-chat');
    expect(row.prompt_tokens).toBe(1234);
    expect(row.completion_tokens).toBe(210);

    expect(report.llm_provider).toBe('deepseek');
    expect(report.llm_model).toBe('deepseek-chat');
    expect(report.llm_fallback_used).toBe(true);
    expect(report.prompt_tokens).toBe(1234);

    expect(emitted).toHaveLength(1);
    const payload = emitted[0].payload as Record<string, unknown>;
    expect(payload.stage).toBe('triage');
    expect(payload.provider).toBe('deepseek');
    expect(payload.model).toBe('deepseek-chat');
    expect(payload.fallback_used).toBe(true);
  });

  it('never calls a provider endpoint itself — every fetch is Supabase', async () => {
    const m = await loadModule({ DEEPSEEK_API_KEY: 'sk-should-not-be-used' });
    await m.investigateIncident({ incident_topic: 'x' });
    expect(fetchCalls.every((c) => c.url.startsWith('https://supa.test/rest/v1/'))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes('deepseek'))).toBe(false);
  });

  it('surfaces a router failure as an error naming the stage, and writes no report', async () => {
    routerResult = { ok: false, error: 'No policy configured for stage \'triage\'' };
    const m = await loadModule();
    await expect(m.investigateIncident({ incident_topic: 'x' })).rejects.toThrow(/triage stage call failed: No policy configured/);
    expect(fetchCalls.some((c) => c.url.includes('/rest/v1/architecture_reports'))).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('treats an empty router text as a failure rather than parsing nothing', async () => {
    routerResult = { ok: true, text: '', provider: 'bedrock', model: 'm' };
    const m = await loadModule();
    await expect(m.investigateIncident({ incident_topic: 'x' })).rejects.toThrow(/triage stage call failed: empty response/);
  });

  describe('resolveInvestigatorOverride — the provider+model pair contract', () => {
    it('is null when neither is set', async () => {
      const m = await loadModule();
      expect(m.resolveInvestigatorOverride({})).toBeNull();
    });
    it('is null on a lone model (the pre-VTID-04234 task-def shape) so a DeepSeek id is never pinned onto a Bedrock call', async () => {
      const m = await loadModule();
      expect(m.resolveInvestigatorOverride({ ARCH_INVESTIGATOR_MODEL: 'deepseek-flash' })).toBeNull();
      expect(m.resolveInvestigatorOverride({ ARCH_INVESTIGATOR_PROVIDER: 'deepseek' })).toBeNull();
    });
    it('passes both through as the router primary override when both are set', async () => {
      const m = await loadModule({ ARCH_INVESTIGATOR_PROVIDER: 'deepseek', ARCH_INVESTIGATOR_MODEL: 'deepseek-flash' });
      expect(m.resolveInvestigatorOverride()).toEqual({ providerOverride: 'deepseek', modelOverride: 'deepseek-flash' });
      await m.investigateIncident({ incident_topic: 'x' });
      expect(routerCalls[0].opts.providerOverride).toBe('deepseek');
      expect(routerCalls[0].opts.modelOverride).toBe('deepseek-flash');
      expect(routerCalls[0].stage).toBe('triage');
    });
  });

  it('source contract: the module has no direct provider client left', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/architecture-investigator.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/api\.deepseek\.com/);
    expect(code).not.toMatch(/DEEPSEEK_API_KEY/);
    expect(code).not.toMatch(/chat\/completions/);
    expect(code).toMatch(/callViaRouter\(ARCH_INVESTIGATOR_STAGE/);
    expect(src).toContain("ARCH_INVESTIGATOR_STAGE = 'triage'");
  });
});
