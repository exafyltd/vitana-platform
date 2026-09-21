/**
 * VTID-04231: the validator (LLM merge review) gets a tool set scoped to a
 * pre-merge reviewer — read_file at the PR head, ci_evidence, dev_get_risk —
 * through the bounded stage loop, fail-open posture unchanged.
 */
jest.mock('../src/services/github-service', () => {
  const getPrFiles = jest.fn();
  const getPullRequest = jest.fn();
  const getFileContents = jest.fn();
  const getCheckRuns = jest.fn();
  return { __esModule: true, default: { getPrFiles, getPullRequest, getCheckRuns }, getPrFiles, getPullRequest, getFileContents, getCheckRuns };
});
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));
jest.mock('../src/services/codeintel-index', () => {
  const actual = jest.requireActual('../src/services/codeintel-index');
  return { ...actual, loadCodeIndex: jest.fn() };
});
jest.mock('../src/services/dev-autopilot-ci-logs', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-ci-logs');
  return { ...actual, collectCiFailureEvidence: jest.fn() };
});

import * as gh from '../src/services/github-service';
import { callViaRouter } from '../src/services/llm-router';
import { loadCodeIndex } from '../src/services/codeintel-index';
import { collectCiFailureEvidence } from '../src/services/dev-autopilot-ci-logs';
import { runLlmMergeReview, isLlmMergeReviewToolsEnabled, buildReviewPrompt, REVIEW_MAX_TURNS, REVIEW_MAX_TOOL_CALLS } from '../src/services/dev-autopilot-llm-review';
import { createValidatorToolExecutor, validatorRouterTools, VALIDATOR_TOOL_NAMES } from '../src/services/dev-autopilot-llm-review-tools';
import * as fs from 'fs';
import * as path from 'path';

const mockRouter = callViaRouter as jest.Mock;
const mockPrFiles = gh.getPrFiles as jest.Mock;
const mockPr = gh.getPullRequest as jest.Mock;
const mockFile = gh.getFileContents as jest.Mock;
const mockChecks = gh.getCheckRuns as jest.Mock;
const mockLoad = loadCodeIndex as jest.Mock;
const mockEvidence = collectCiFailureEvidence as jest.Mock;

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED;
  mockPrFiles.mockResolvedValue([{ filename: 'services/gateway/src/x.ts', status: 'modified', patch: '+const a = 1', additions: 1, deletions: 0 }]);
  mockPr.mockResolvedValue({ number: 7, head: { sha: HEAD, ref: 'dev-autopilot/x' } });
});

describe('isLlmMergeReviewToolsEnabled', () => {
  it('is on by default and off only for the exact string false', () => {
    expect(isLlmMergeReviewToolsEnabled({})).toBe(true);
    expect(isLlmMergeReviewToolsEnabled({ DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED: 'false' })).toBe(false);
    expect(isLlmMergeReviewToolsEnabled({ DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED: '0' })).toBe(true);
  });
});

describe('validatorRouterTools', () => {
  it('declares exactly the three scoped read-only tools', () => {
    expect(validatorRouterTools().map((t) => t.name)).toEqual([...VALIDATOR_TOOL_NAMES]);
    expect(VALIDATOR_TOOL_NAMES).toEqual(['read_file', 'ci_evidence', 'dev_get_risk']);
    for (const t of validatorRouterTools()) expect(t.inputSchema).toMatchObject({ type: 'object' });
  });

  it('the prompt names the tools only when they are available', () => {
    expect(buildReviewPrompt('VTID-1', 'd', true)).toMatch(/read_file\(path/);
    expect(buildReviewPrompt('VTID-1', 'd', false)).not.toMatch(/read_file/);
    expect(buildReviewPrompt('VTID-1', 'd')).not.toMatch(/ci_evidence/);
  });
});

describe('createValidatorToolExecutor', () => {
  const exec = () => createValidatorToolExecutor({ repo: 'exafyltd/vitana-platform', headSha: HEAD });

  it('read_file reads at the PR head sha and windows/numbers the lines', async () => {
    mockFile.mockResolvedValue({ type: 'file', path: 'services/gateway/src/x.ts', content: Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'), size: 1, sha: 'f' });
    const out = await exec()('read_file', { path: 'services/gateway/src/x.ts', start_line: 3, end_line: 5 });
    expect(mockFile).toHaveBeenCalledWith('exafyltd/vitana-platform', 'services/gateway/src/x.ts', HEAD);
    expect(out.isError).toBeFalsy();
    expect(out.result).toContain('3: line3');
    expect(out.result).toContain('5: line5');
    expect(out.result).not.toContain('6: line6');
    expect(out.result).toMatch(/5 more line\(s\); the file has 10 lines/);
  });

  it('read_file lists a directory and refuses a missing path', async () => {
    mockFile.mockResolvedValue({ type: 'dir', path: 'src', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] });
    expect((await exec()('read_file', { path: 'src' })).result).toContain('file src/a.ts');
    expect((await exec()('read_file', {})).isError).toBe(true);
  });

  it('ci_evidence lists the head check-runs and fetches excerpts only for failing ones', async () => {
    mockChecks.mockResolvedValue({ check_runs: [
      { name: 'validate-pr', status: 'completed', conclusion: 'success' },
      { name: 'gateway-tests', status: 'completed', conclusion: 'failure' },
    ] });
    mockEvidence.mockResolvedValue([{ check_name: 'gateway-tests', job_id: 42, excerpt: 'FAIL test/x.test.ts' }]);
    const out = await exec()('ci_evidence', {});
    expect(mockChecks).toHaveBeenCalledWith('exafyltd/vitana-platform', HEAD);
    expect(mockEvidence).toHaveBeenCalledWith({ owner: 'exafyltd', repo: 'vitana-platform', headSha: HEAD, failedNames: ['gateway-tests'] });
    expect(out.result).toContain('- validate-pr: completed / success');
    expect(out.result).toContain('1 failing');
    expect(out.result).toContain('FAIL test/x.test.ts');
  });

  it('ci_evidence with all-green checks fetches no logs', async () => {
    mockChecks.mockResolvedValue({ check_runs: [{ name: 'a', status: 'completed', conclusion: 'success' }] });
    const out = await exec()('ci_evidence', {});
    expect(mockEvidence).not.toHaveBeenCalled();
    expect(out.result).toContain('0 failing');
  });

  it('dev_get_risk loads the code index once and answers from it; a load failure is an error result', async () => {
    const actual = jest.requireActual('../src/services/codeintel-index');
    const manifest = { format: 1, repo: 'exafyltd/vitana-platform', sha: 'deadbeef', built_at: 'now', files: { graph: 'g', risk: 'r' }, counts: {} };
    const graph = { format: 1, relations: ['contains'], nodes: [['n1', 'x.ts', 'code', 'services/gateway/src/x.ts', 'L1', 'file']], edges: [] };
    const risk = {
      format: 1,
      files: { 'services/gateway/src/x.ts': { commits_total: 3, commits_90d: 2, last_commit: '2026-09-21', owner: 'exafyltd', owner_pct: 100, bug_fixes: 1, hotspot: false, layer: null, role: null, public_symbols: 1, depends_on: [], used_by: [], changes_together_with: [], overview: 'x' } },
      hotspots: {}, dead_code: {}, decisions: [],
    };
    const bundle = actual.assembleBundle(manifest, graph, risk);
    mockLoad.mockResolvedValue({ bundle, fromCache: false, source: 'test', loadMs: 1 });
    const e = exec();
    const a = await e('dev_get_risk', { path: 'services/gateway/src/x.ts' });
    const b = await e('dev_get_risk', { path: 'services/gateway/src/x.ts' });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(a.isError).toBeFalsy();
    expect(a.result).toContain('services/gateway/src/x.ts');
    expect(b.result).toBe(a.result);
    mockLoad.mockRejectedValueOnce(new Error('bucket unreachable'));
    const c = await exec()('dev_get_risk', { path: 'services/gateway/src/x.ts' });
    expect(c.isError).toBe(true);
    expect(c.result).toContain('bucket unreachable');
  });

  it('an unknown tool is an error result naming the allowed set', async () => {
    const out = await exec()('write_file', { path: 'x' });
    expect(out.isError).toBe(true);
    expect(out.result).toContain('read_file, ci_evidence, dev_get_risk');
  });
});

describe('runLlmMergeReview with tools (VTID-04231)', () => {
  it('runs the validator stage with the three tools, executes a read_file round at the PR head, and returns the parsed verdict with provider/tool telemetry', async () => {
    mockFile.mockResolvedValue({ type: 'file', path: 'services/gateway/src/x.ts', content: 'const a = 1;\nexport default a;', size: 1, sha: 'f' });
    mockRouter
      .mockResolvedValueOnce({ ok: true, toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'services/gateway/src/x.ts' } }], provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-5-20251101-v1:0' })
      .mockResolvedValueOnce({ ok: true, text: '{"verdict":"pass"}', provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-5-20251101-v1:0' });
    const r = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(r).toMatchObject({ ok: true, passed: true, provider: 'bedrock', tool_calls: 1, tools_used: ['read_file'] });
    expect(r.summary).toContain('read_file');
    expect(mockRouter).toHaveBeenCalledTimes(2);
    const [stage, prompt, opts] = mockRouter.mock.calls[0];
    expect(stage).toBe('validator');
    expect(prompt).toMatch(/read_file\(path/);
    expect(opts).toMatchObject({ vtid: 'VTID-DEV-AUTOPILOT', service: 'dev-autopilot-llm-review', allowFallback: true, maxTokens: 1000 });
    expect((opts.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['read_file', 'ci_evidence', 'dev_get_risk']);
    expect(mockFile).toHaveBeenCalledWith('exafyltd/vitana-platform', 'services/gateway/src/x.ts', HEAD);
    const second = mockRouter.mock.calls[1][2];
    expect(second.history[2].toolResults[0]).toMatchObject({ id: 't1', name: 'read_file' });
    expect(second.history[2].toolResults[0].result).toContain('1: const a = 1;');
  });

  it('a block verdict after a tool round blocks with the reasons', async () => {
    mockChecks.mockResolvedValue({ check_runs: [] });
    mockRouter
      .mockResolvedValueOnce({ ok: true, toolCalls: [{ name: 'ci_evidence', arguments: {} }] })
      .mockResolvedValueOnce({ ok: true, text: '{"verdict":"block","reasons":["hardcoded key"]}' });
    const r = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-X' });
    expect(r).toMatchObject({ ok: true, passed: false, tool_calls: 1, tools_used: ['ci_evidence'] });
    expect(r.summary).toContain('hardcoded key');
  });

  it('fails open when the router fails mid-loop and when the model never answers with a verdict', async () => {
    mockRouter.mockResolvedValueOnce({ ok: true, toolCalls: [{ name: 'ci_evidence', arguments: {} }] }).mockResolvedValueOnce({ ok: false, error: 'throttled' });
    mockChecks.mockResolvedValue({ check_runs: [] });
    const r = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-X' });
    expect(r).toMatchObject({ ok: false, passed: true });
    expect(r.error).toContain('throttled');
    mockRouter.mockReset();
    mockRouter.mockResolvedValue({ ok: true, text: 'prose, no json' });
    const r2 = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-X' });
    expect(r2).toMatchObject({ ok: false, passed: true, error: 'unparseable_verdict' });
  });

  it('bounds the loop: after REVIEW_MAX_TOOL_CALLS the verdict is requested without tools', async () => {
    mockChecks.mockResolvedValue({ check_runs: [] });
    mockRouter.mockImplementation(async (_s: string, _p: string, opts: { tools?: unknown[] }) =>
      opts.tools ? { ok: true, toolCalls: Array.from({ length: 3 }, () => ({ name: 'ci_evidence', arguments: {} })) } : { ok: true, text: '{"verdict":"pass"}' });
    const r = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-X' });
    expect(r.passed).toBe(true);
    expect(r.tool_calls).toBe(REVIEW_MAX_TOOL_CALLS);
    expect(mockRouter.mock.calls.length).toBeLessThanOrEqual(REVIEW_MAX_TURNS + 1);
    expect(mockRouter.mock.calls[mockRouter.mock.calls.length - 1][2].tools).toBeUndefined();
  });

  it('reviews single-shot with no tools when the PR head cannot be resolved or the tools flag is false', async () => {
    mockPr.mockRejectedValueOnce(new Error('404'));
    mockRouter.mockResolvedValue({ ok: true, text: '{"verdict":"pass"}' });
    const r = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-X' });
    expect(r).toMatchObject({ ok: true, passed: true, tool_calls: 0 });
    expect(mockRouter.mock.calls[0][2].tools).toBeUndefined();
    expect(mockRouter.mock.calls[0][1]).not.toMatch(/read_file/);
    process.env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED = 'false';
    mockRouter.mockClear();
    await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 7, vtid: 'VTID-X' });
    expect(mockPr).toHaveBeenCalledTimes(1);
    expect(mockRouter.mock.calls[0][2].tools).toBeUndefined();
  });

  it('source contract: the watcher forwards the review telemetry on its OASIS event', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
    expect(src).toMatch(/tool_calls: review\.tool_calls/);
    expect(src).toMatch(/provider: review\.provider/);
  });
});
