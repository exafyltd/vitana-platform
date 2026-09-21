/**
 * VTID-04223: engineering memory for the agent executor.
 *
 * Pins: the default-on flag; the recall query shape; prior-run rendering
 * (newest first, current run excluded, capped); the assembled block's
 * order + cap; fail-open per source (one source failing never drops the
 * others; all failing yields '' and the errors are reported); the
 * bootstrap governance-rules section is dropped (the clone's CLAUDE.md
 * already covers it); the transcript renderer keeps the tail; the
 * end-of-run extraction writes executor-tagged rows through the shared
 * VTID-04025 extractor with the console gate forced open for that call
 * only; the prompt appends the block; and the runner wiring (source
 * contract: built before the loop, step emitted, recorded in `finally`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../src/services/dev-autopilot-execute', () => ({ supa: jest.fn() }));
jest.mock('../src/services/dev-agent-memory', () => ({ recallDevMemory: jest.fn(), writeDevMemory: jest.fn() }));
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));

import {
  AGENT_BOOTSTRAP_HEADER, AGENT_BOOTSTRAP_MAX_CHARS, AGENT_MEMORY_HEADER, AGENT_MEMORY_TOTAL_MAX_CHARS, AGENT_PRIOR_RUNS_MAX,
  buildAgentMemoryContext, buildAgentRecallQuery, isAgentMemoryContextEnabled, recordAgentRunMemory,
  renderAgentMemoryContext, renderAgentTranscript, renderPriorAgentRuns,
} from '../src/services/autopilot-agent/agent-memory-context';
import { BOOTSTRAP_RULES_SECTION_TITLE, type PackSection } from '../src/services/operator-bootstrap-pack';
import { buildAgentSystemPrompt } from '../src/services/autopilot-agent/agent-prompt';
import type { DevMemoryHit } from '../src/services/dev-agent-memory';
import type { LLMRouterMessage } from '../src/services/llm-router';

const S = { url: 'https://supa.test', key: 'k' };
const hit = (i: number, category: DevMemoryHit['category'] = 'gotcha'): DevMemoryHit => ({
  id: `h${i}`, vtid: null, category, title: `Memory ${i} title`, content: `Content ${i} `.repeat(10), importance: 50, source: 'session', tags: [], created_at: '2026-09-21T00:00:00Z', similarity: 0.9 - i * 0.01,
});
const sections = (): PackSection[] => [
  { title: BOOTSTRAP_RULES_SECTION_TITLE, body: 'RULES THAT MUST NOT APPEAR TWICE' },
  { title: 'Service path map (config/service-path-map.json)', body: 'gateway → services/gateway' },
  { title: 'Open pull requests', body: '- exafyltd/vitana-platform#1 x' },
  { title: 'Live build-info', error: 'timed out' },
];
const input = { executionId: 'exec-current-1234', findingId: 'finding-1', vtid: 'VTID-04223', planMarkdown: 'Fix the watcher ' + 'x'.repeat(50) };

beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('VTID-04223 flag + pure renderers', () => {
  it('is on by default and off only on the exact string false', () => {
    expect(isAgentMemoryContextEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isAgentMemoryContextEnabled({ AGENT_MEMORY_CONTEXT_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAgentMemoryContextEnabled({ AGENT_MEMORY_CONTEXT_ENABLED: 'FALSE' } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('recall query carries the VTID, the plan (bounded) and the prior failure', () => {
    const q = buildAgentRecallQuery({ vtid: 'VTID-1', planMarkdown: 'p'.repeat(5_000), priorFailure: 'tsc failed' });
    expect(q.startsWith('VTID-1\n')).toBe(true);
    expect(q).toContain('tsc failed');
    expect(q.length).toBeLessThan(2_100);
  });
  it('prior runs: newest first, current execution excluded, capped, error clipped', () => {
    const runs = Array.from({ length: 8 }, (_, i) => ({ execution_id: `e${i}`.padEnd(12, '0'), outcome: i % 2 ? 'failed' : 'pr_opened', turns: i, fix_rounds: 0, model: 'deepseek-flash', cost_usd: 0.01 * i, error: i % 2 ? 'boom '.repeat(100) : null, recorded_at: `2026-09-21T10:0${i}:00Z` }));
    runs.push({ execution_id: 'exec-current-1234', outcome: 'failed', turns: 1, fix_rounds: 0, model: 'x', cost_usd: 0, error: 'me', recorded_at: '2026-09-21T11:00:00Z' });
    const text = renderPriorAgentRuns(runs, 'exec-current-1234');
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(AGENT_PRIOR_RUNS_MAX);
    expect(lines[0]).toMatch(/^- e7000000: outcome=failed/);
    expect(text).not.toContain('exec-cur');
    expect(text).toContain('do not repeat what already failed');
    expect(lines[0].length).toBeLessThan(420);
    expect(renderPriorAgentRuns(undefined, 'x')).toBe('');
    expect(renderPriorAgentRuns([{ execution_id: 'x' }], 'x')).toBe('');
  });
  it('assembles prior runs, then recall, then bootstrap under one header and caps the total', () => {
    const text = renderAgentMemoryContext({ bootstrap: 'B'.repeat(50_000), recall: 'RECALL', priorRuns: 'PRIOR' });
    expect(text.startsWith(AGENT_MEMORY_HEADER)).toBe(true);
    expect(text.indexOf('PRIOR')).toBeLessThan(text.indexOf('RECALL'));
    expect(text.indexOf('RECALL')).toBeLessThan(text.indexOf('BBBB'));
    expect(text.length).toBeLessThanOrEqual(AGENT_MEMORY_TOTAL_MAX_CHARS + 1);
    expect(renderAgentMemoryContext({ bootstrap: '', recall: '  ', priorRuns: '' })).toBe('');
  });
  it('transcript renderer covers every message shape and keeps the tail', () => {
    const history: LLMRouterMessage[] = [
      { role: 'user', content: 'start ' + 'a'.repeat(9_000) },
      { role: 'assistant', toolCalls: [{ name: 'read_file', arguments: { path: 'x.ts' } }] },
      { role: 'user', toolResults: [{ name: 'read_file', result: 'const x = 1;', isError: false }, { name: 'run_check', result: 'tsc failed', isError: true }] },
      { role: 'assistant', content: 'LAST-LINE' },
    ];
    const t = renderAgentTranscript(history, 400);
    expect(t.length).toBeLessThanOrEqual(401);
    expect(t).toContain('LAST-LINE');
    expect(t).toContain('run_check ERROR');
    const full = renderAgentTranscript(history);
    expect(full).toContain('ASSISTANT→tools: read_file({"path":"x.ts"})');
  });
});

describe('VTID-04223 buildAgentMemoryContext (fail-open per source)', () => {
  it('assembles all three sources, drops the governance-rules section, reports stats', async () => {
    const r = await buildAgentMemoryContext(input, S, {
      buildSections: async () => sections(),
      bootstrapDeps: {},
      recall: async () => ({ ok: true, hits: [hit(1, 'gotcha'), hit(2, 'decision'), hit(3, 'gotcha')] }),
      readPriorRuns: async () => [{ execution_id: 'prev-0000', outcome: 'failed', error: 'jest failed' }, { execution_id: 'exec-current-1234', outcome: 'failed' }],
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.text).toContain(AGENT_MEMORY_HEADER);
    expect(r.text).toContain('Service path map');
    expect(r.text).not.toContain('RULES THAT MUST NOT APPEAR TWICE');
    expect(r.text).toContain('Memory 1 title');
    expect(r.text).toContain('prev-000: outcome=failed');
    expect(r.text).toContain(AGENT_BOOTSTRAP_HEADER);
    expect(r.text).not.toMatch(/dev_read_file/);
    expect(r.stats).toMatchObject({ enabled: true, bootstrap_sections: 2, recall_rows: 3, prior_runs: 1, errors: [] });
    expect(r.stats.recall_titles[0]).toBe('Memory 1 title');
    expect(r.stats.total_chars).toBe(r.text.length);
    expect(r.stats.bootstrap_chars).toBeLessThanOrEqual(AGENT_BOOTSTRAP_MAX_CHARS + 1);
  });
  it('one failing source never drops the others; the error is named', async () => {
    const r = await buildAgentMemoryContext(input, S, {
      buildSections: async () => { throw new Error('github down'); },
      recall: async () => ({ ok: false, error: 'embedding_failed' }),
      readPriorRuns: async () => [{ execution_id: 'prev-0000', outcome: 'failed' }],
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.text).toContain('prev-000');
    expect(r.stats.errors).toEqual(['bootstrap: github down', 'recall: embedding_failed']);
  });
  it('a hung source is bounded by the timeout', async () => {
    const r = await buildAgentMemoryContext(input, S, {
      buildSections: () => new Promise(() => {}),
      recall: async () => ({ ok: true, hits: [hit(1)] }),
      readPriorRuns: async () => [],
      env: {} as NodeJS.ProcessEnv, timeoutMs: 50,
    });
    expect(r.stats.errors[0]).toMatch(/bootstrap: bootstrap pack timed out after 50ms/);
    expect(r.text).toContain('Memory 1 title');
  });
  it('all sources failing yields an empty block, never a throw', async () => {
    const r = await buildAgentMemoryContext(input, null, {
      buildSections: async () => { throw new Error('x'); },
      recall: async () => { throw new Error('y'); },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.text).toBe('');
    expect(r.stats.total_chars).toBe(0);
    expect(r.stats.errors).toHaveLength(2);
  });
  it('disabled → empty, no source touched', async () => {
    const buildSections = jest.fn();
    const r = await buildAgentMemoryContext(input, S, { buildSections, env: { AGENT_MEMORY_CONTEXT_ENABLED: 'false' } as NodeJS.ProcessEnv });
    expect(r.text).toBe('');
    expect(r.stats.enabled).toBe(false);
    expect(buildSections).not.toHaveBeenCalled();
  });
});

describe('VTID-04223 recordAgentRunMemory (memory out)', () => {
  const history: LLMRouterMessage[] = [
    { role: 'user', content: 'Task: fix the watcher' },
    { role: 'assistant', toolCalls: [{ name: 'run_check', arguments: { kind: 'tsc' } }] },
    { role: 'user', toolResults: [{ name: 'run_check', result: 'TS2742 symlink realpath', isError: true }] },
    { role: 'assistant', content: 'done' },
  ];
  it('writes executor-tagged rows through the shared extractor with the console gate forced open for that call', async () => {
    const extract = jest.fn(async () => JSON.stringify([{ category: 'gotcha', title: 'tsc needs --preserveSymlinks in the clone', content: 'The clone symlinks node_modules; tsc resolves realpaths outside the project and fails with TS2742.', importance: 60 }]));
    const write = jest.fn(async () => ({ ok: true as const, id: 'row-1' }));
    const r = await recordAgentRunMemory(
      { executionId: 'exec-current-1234', vtid: 'VTID-04223', taskText: 'fix the watcher', history, finished: { summary: 'fixed', pr_title: 't', pr_body: 'b' }, outcome: 'pr_opened' },
      { env: {} as NodeJS.ProcessEnv, extract, write },
    );
    expect(r).toEqual({ written: 1 });
    const prompt = (extract.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain('Run outcome: pr_opened');
    expect(prompt).toContain('run_check: TS2742');
    const row = (write.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(row).toMatchObject({ repo: 'vitana-platform', category: 'gotcha', vtid: 'VTID-04223', source: 'autopilot', tags: ['dev-autopilot', 'agent-executor', 'run-extracted', 'gotcha'] });
    expect(String(row.content)).toContain('agent executor run exec-cur');
    expect(String(row.content)).not.toContain('Operator Console thread');
  });
  it('disabled or empty transcript → nothing extracted', async () => {
    const extract = jest.fn();
    expect(await recordAgentRunMemory({ executionId: 'e', vtid: null, taskText: 't', history, finished: null, outcome: 'failed' }, { env: { AGENT_MEMORY_CONTEXT_ENABLED: 'false' } as NodeJS.ProcessEnv, extract })).toEqual({ written: 0, skipped: 'disabled' });
    expect(await recordAgentRunMemory({ executionId: 'e', vtid: null, taskText: 't', history: [], finished: null, outcome: 'failed' }, { env: {} as NodeJS.ProcessEnv, extract })).toEqual({ written: 0, skipped: 'no_transcript' });
    expect(extract).not.toHaveBeenCalled();
  });
  it('an extractor failure is swallowed', async () => {
    const r = await recordAgentRunMemory({ executionId: 'e', vtid: null, taskText: 'fix the watcher', history, finished: null, outcome: 'failed', error: 'x' }, { env: {} as NodeJS.ProcessEnv, extract: async () => { throw new Error('router down'); } });
    expect(r.written).toBe(0);
  });
});

describe('VTID-04223 prompt + runner wiring (source contract)', () => {
  const base = { repo: 'exafyltd/vitana-platform', baseBranch: 'main', branch: 'dev-autopilot/x', vtid: 'VTID-1', allowScope: ['services/gateway/src/**'], denyScope: ['.env'], conventions: 'CONV', claudeMdExcerpt: 'RULES' };
  it('the system prompt appends the memory block after the governance rules, and omits it when empty', () => {
    const withMem = buildAgentSystemPrompt({ ...base, memoryContext: `${AGENT_MEMORY_HEADER}\nMEM` });
    expect(withMem.indexOf('RULES')).toBeLessThan(withMem.indexOf(AGENT_MEMORY_HEADER));
    expect(withMem.endsWith('MEM')).toBe(true);
    expect(buildAgentSystemPrompt({ ...base, memoryContext: '  ' })).toBe(buildAgentSystemPrompt(base));
  });
  it('the runner builds the block before the loop, emits runner:memory_context, and records memory in finally', () => {
    const src = readFileSync(join(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');
    const build = src.indexOf('await buildAgentMemoryContext(');
    const prompt = src.indexOf('memoryContext: memory.text');
    const loop = src.indexOf('await runAgentLoop(');
    const record = src.indexOf('await recordAgentRunMemory(');
    const fin = src.indexOf('} finally {');
    expect(build).toBeGreaterThan(0);
    expect(build).toBeLessThan(prompt);
    expect(prompt).toBeLessThan(loop);
    expect(src).toContain("name: 'runner:memory_context'");
    expect(src).toContain("name: 'runner:memory_record'");
    expect(record).toBeGreaterThan(fin);
  });
  it('the executor workflow pins the flag and the build-info targets on the task definition', () => {
    const wf = readFileSync(join(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml'), 'utf8');
    expect(wf).toMatch(/\{name:"AGENT_MEMORY_CONTEXT_ENABLED", value:"true"\}/);
    expect(wf).toMatch(/\{name:"OPERATOR_BOOTSTRAP_BUILD_INFO_URLS", value:"staging=https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/admin\/build-info,prod=https:\/\/gateway\.vitanaland\.com\/api\/v1\/admin\/build-info"\}/);
    expect(wf).toMatch(/IN\("BEDROCK_ROLE_ARN","AWS_BEDROCK_REGION","AGENT_MAX_TURNS","AGENT_DEADLINE_MS","AGENT_MEMORY_CONTEXT_ENABLED","OPERATOR_BOOTSTRAP_BUILD_INFO_URLS","DEV_AUTOPILOT_EXECUTOR","DEV_AUTOPILOT_PR_APPROVAL_REQUIRED"\)/);
  });
});
