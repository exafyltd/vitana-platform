/**
 * VTID-04233: the operator planner's spec generator runs on the `planner`
 * routing stage through the shared stage loop, with the VTID-04229 codebase
 * index tools when the index loads — no direct Bedrock call.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/spec-quality-agent', () => ({ runFullQualityCheck: jest.fn() }));

import * as fs from 'fs';
import * as path from 'path';
import {
  callSpecGenerator, isSpecGenIndexToolsEnabled, SPEC_GEN_STAGE, SPEC_GEN_SERVICE, SPEC_GEN_MAX_TOKENS, SPEC_GEN_MAX_TURNS, SPEC_GEN_MAX_TOOL_CALLS, SPEC_GEN_SYSTEM_PROMPT, SPEC_GEN_REPO,
} from '../src/routes/specs';
import { assembleBundle } from '../src/services/codeintel-index';

function bundle() {
  return assembleBundle(
    { format: 1, repo: 'exafyltd/vitana-platform', sha: 'deadbeef', built_at: 'now', files: { graph: 'g', risk: 'r' }, counts: {} },
    { format: 1, relations: ['contains'], nodes: [['n1', 'specs.ts', 'code', 'services/gateway/src/routes/specs.ts', 'L1', 'file']], edges: [] },
    { format: 1, files: { 'services/gateway/src/routes/specs.ts': { commits_total: 9, commits_90d: 4, last_commit: '2026-09-21', owner: 'exafyltd', owner_pct: 100, bug_fixes: 2, hotspot: true, layer: null, role: null, public_symbols: 3, depends_on: [], used_by: [], changes_together_with: [], overview: 'spec route' } }, hotspots: {}, dead_code: {}, decisions: [] },
  );
}

describe('callSpecGenerator (VTID-04233)', () => {
  afterEach(() => { delete process.env.SPEC_GEN_INDEX_TOOLS_ENABLED; });

  it('runs the planner stage through the stage loop with the three index tools when the index loads', async () => {
    const runLoop = jest.fn(async (o: any) => ({ ok: true, text: 'SPEC', provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-5-20251101-v1:0', fallbackUsed: false, usage: { inputTokens: 1, outputTokens: 1 }, turns: 2, toolCalls: 1, toolNames: ['dev_get_risk'], history: [], steps: [], budgetExhausted: false }));
    const loadIndex = jest.fn(async () => ({ bundle: bundle(), fromCache: false, source: 't', loadMs: 1 }));
    const r = await callSpecGenerator('VTID-1', 'make a spec', { runLoop: runLoop as any, loadIndex: loadIndex as any });
    expect(loadIndex).toHaveBeenCalledWith(SPEC_GEN_REPO);
    expect(r).toMatchObject({ text: 'SPEC', provider: 'bedrock', toolCalls: 1, toolNames: ['dev_get_risk'] });
    const o = runLoop.mock.calls[0][0];
    expect(o).toMatchObject({ stage: SPEC_GEN_STAGE, service: SPEC_GEN_SERVICE, vtid: 'VTID-1', systemPrompt: SPEC_GEN_SYSTEM_PROMPT, prompt: 'make a spec', maxTokens: SPEC_GEN_MAX_TOKENS, maxTurns: SPEC_GEN_MAX_TURNS, maxToolCalls: SPEC_GEN_MAX_TOOL_CALLS, allowFallback: true });
    expect(SPEC_GEN_STAGE).toBe('planner');
    expect(o.tools.map((t: { name: string }) => t.name)).toEqual(['dev_index_query', 'dev_graph_path', 'dev_get_risk']);
    // the execute runs the real index tool against the loaded bundle
    const risk = await o.execute('dev_get_risk', { path: 'services/gateway/src/routes/specs.ts' });
    expect(risk.isError).toBeFalsy();
    expect(risk.result).toContain('services/gateway/src/routes/specs.ts');
    expect((await o.execute('write_file', {})).isError).toBe(true);
  });

  it('plans without tools (single shot) when the index cannot be loaded or the flag is false — never fails the generation', async () => {
    const runLoop = jest.fn(async () => ({ ok: true, text: 'SPEC', fallbackUsed: false, usage: { inputTokens: 0, outputTokens: 0 }, turns: 1, toolCalls: 0, toolNames: [], history: [], steps: [], budgetExhausted: false }));
    const loadIndex = jest.fn(async () => { throw new Error('bucket unreachable'); });
    const r = await callSpecGenerator('VTID-1', 'p', { runLoop: runLoop as any, loadIndex: loadIndex as any });
    expect(r.text).toBe('SPEC');
    expect(runLoop.mock.calls[0][0]).toMatchObject({ tools: [], maxTurns: 1, maxToolCalls: 0, stage: 'planner' });
    expect((await runLoop.mock.calls[0][0].execute('dev_get_risk', {})).isError).toBe(true);
    process.env.SPEC_GEN_INDEX_TOOLS_ENABLED = 'false';
    loadIndex.mockClear();
    await callSpecGenerator('VTID-1', 'p', { runLoop: runLoop as any, loadIndex: loadIndex as any });
    expect(loadIndex).not.toHaveBeenCalled();
    expect(isSpecGenIndexToolsEnabled({ SPEC_GEN_INDEX_TOOLS_ENABLED: 'false' })).toBe(false);
    expect(isSpecGenIndexToolsEnabled({})).toBe(true);
  });

  it('a loop failure yields text:null with the error so the route falls back to its template', async () => {
    const runLoop = jest.fn(async () => ({ ok: false, error: 'planner stage call failed on turn 1: no provider', fallbackUsed: false, usage: { inputTokens: 0, outputTokens: 0 }, turns: 1, toolCalls: 0, toolNames: [], history: [], steps: [], budgetExhausted: false }));
    const r = await callSpecGenerator('VTID-1', 'p', { runLoop: runLoop as any, loadIndex: (async () => { throw new Error('x'); }) as any });
    expect(r.text).toBeNull();
    expect(r.error).toContain('no provider');
  });

  it('source contract: no direct Bedrock/Claude client left in the spec route; the prompt names the index tools', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/specs.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/claude-text-client|callClaudeText\(|invokeBedrock\(/);
    expect(src).toMatch(/runStageToolLoop/);
    expect(src).toMatch(/dev_index_query, dev_graph_path, dev_get_risk/);
  });
});
