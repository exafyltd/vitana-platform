/**
 * VTID-03853: real LLM merge review, wired into the ONE path
 * dev_autopilot_executions rows actually merge through
 * (dev-autopilot-watcher.ts's ciWatcherTick) — see
 * dev-autopilot-llm-review.ts's header comment for why autopilot-validator.ts
 * was the wrong file to fix (its validateForMerge() is not in that call
 * path at all).
 */

jest.mock('../src/services/github-service', () => ({
  __esModule: true,
  default: {
    getPrFiles: jest.fn(),
  },
}));

jest.mock('../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));

import githubService from '../src/services/github-service';
import { callViaRouter } from '../src/services/llm-router';
import {
  isLlmMergeReviewEnabled,
  runLlmMergeReview,
  buildDiffBundle,
  buildReviewPrompt,
  parseReviewVerdict,
} from '../src/services/dev-autopilot-llm-review';

const mockGetPrFiles = githubService.getPrFiles as jest.Mock;
const mockCallViaRouter = callViaRouter as jest.Mock;

describe('isLlmMergeReviewEnabled (VTID-03853)', () => {
  const ORIGINAL = process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED;
    else process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED = ORIGINAL;
  });

  it('defaults to false (off) when unset', () => {
    delete process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED;
    expect(isLlmMergeReviewEnabled()).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED = 'true';
    expect(isLlmMergeReviewEnabled()).toBe(true);
    process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED = '1';
    expect(isLlmMergeReviewEnabled()).toBe(false);
  });
});

describe('parseReviewVerdict', () => {
  it('parses a clean pass verdict', () => {
    expect(parseReviewVerdict('{"verdict":"pass"}')).toEqual({ verdict: 'pass', reasons: [] });
  });

  it('parses a block verdict with reasons', () => {
    expect(parseReviewVerdict('{"verdict":"block","reasons":["hardcoded API key in config.ts"]}')).toEqual({
      verdict: 'block',
      reasons: ['hardcoded API key in config.ts'],
    });
  });

  it('extracts JSON even when the model wraps it in prose or a markdown fence', () => {
    const text = 'Sure, here is my review:\n```json\n{"verdict":"pass"}\n```\nLet me know if you need more.';
    expect(parseReviewVerdict(text)).toEqual({ verdict: 'pass', reasons: [] });
  });

  it('returns null for unparseable text', () => {
    expect(parseReviewVerdict('I could not review this diff.')).toBeNull();
  });

  it('returns null for a JSON object with neither a pass nor block verdict', () => {
    expect(parseReviewVerdict('{"verdict":"maybe"}')).toBeNull();
  });

  it('treats a non-array reasons field as empty rather than throwing', () => {
    expect(parseReviewVerdict('{"verdict":"block","reasons":"not an array"}')).toEqual({
      verdict: 'block',
      reasons: [],
    });
  });
});

describe('buildDiffBundle', () => {
  it('includes each file patch under a diff fence', () => {
    const bundle = buildDiffBundle([
      { filename: 'services/gateway/src/x.ts', status: 'modified', patch: '@@ -1,2 +1,2 @@\n-old\n+new' },
    ]);
    expect(bundle).toContain('services/gateway/src/x.ts');
    expect(bundle).toContain('```diff');
    expect(bundle).toContain('-old');
    expect(bundle).toContain('+new');
  });

  it('notes a file with no patch (binary/too large) instead of omitting it silently', () => {
    const bundle = buildDiffBundle([{ filename: 'assets/logo.png', status: 'added' }]);
    expect(bundle).toContain('assets/logo.png');
    expect(bundle).toContain('no textual diff');
  });

  it('caps total diff size rather than sending an unbounded prompt', () => {
    const hugePatch = '+'.repeat(30_000);
    const bundle = buildDiffBundle([
      { filename: 'a.ts', status: 'modified', patch: hugePatch },
      { filename: 'b.ts', status: 'modified', patch: 'short' },
    ]);
    // b.ts's patch must not appear — the budget was exhausted by a.ts alone.
    expect(bundle).not.toContain('short');
    expect(bundle).toContain('not shown');
  });
});

describe('buildReviewPrompt', () => {
  it('includes the vtid, the diff, and instructs strict JSON-only output', () => {
    const prompt = buildReviewPrompt('VTID-99999', '### x.ts\n```diff\n+foo\n```');
    expect(prompt).toContain('VTID-99999');
    expect(prompt).toContain('+foo');
    expect(prompt).toMatch(/JSON object/);
    expect(prompt).toContain('"verdict":"pass"');
  });
});

describe('runLlmMergeReview', () => {
  beforeEach(() => {
    mockGetPrFiles.mockReset();
    mockCallViaRouter.mockReset();
  });

  it('passes cleanly when the model returns a pass verdict', async () => {
    mockGetPrFiles.mockResolvedValue([{ filename: 'a.ts', status: 'modified', patch: '+ok', additions: 1, deletions: 0 }]);
    mockCallViaRouter.mockResolvedValue({ ok: true, text: '{"verdict":"pass"}' });
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 42, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(result).toEqual({ ok: true, passed: true, summary: 'LLM review found no blocking issues' });
    expect(mockCallViaRouter).toHaveBeenCalledWith('validator', expect.any(String), expect.objectContaining({ vtid: 'VTID-DEV-AUTOPILOT', allowFallback: true }));
  });

  it('blocks on a real block verdict, surfacing the model reasons', async () => {
    mockGetPrFiles.mockResolvedValue([{ filename: 'config.ts', status: 'modified', patch: '+const key = "sk-abc123"', additions: 1, deletions: 0 }]);
    mockCallViaRouter.mockResolvedValue({ ok: true, text: '{"verdict":"block","reasons":["hardcoded API key"]}' });
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 42, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('hardcoded API key');
  });

  it('fails open (does not block) when the diff fetch throws', async () => {
    mockGetPrFiles.mockRejectedValue(new Error('GitHub 500'));
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 42, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(result.ok).toBe(false);
    expect(result.passed).toBe(true);
    expect(mockCallViaRouter).not.toHaveBeenCalled();
  });

  it('fails open when the router call itself fails', async () => {
    mockGetPrFiles.mockResolvedValue([{ filename: 'a.ts', status: 'modified', patch: '+ok', additions: 1, deletions: 0 }]);
    mockCallViaRouter.mockResolvedValue({ ok: false, error: 'no provider configured' });
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 42, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(result.ok).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.error).toBe('no provider configured');
  });

  it('fails open when the response cannot be parsed as a verdict', async () => {
    mockGetPrFiles.mockResolvedValue([{ filename: 'a.ts', status: 'modified', patch: '+ok', additions: 1, deletions: 0 }]);
    mockCallViaRouter.mockResolvedValue({ ok: true, text: 'I refuse to answer in JSON.' });
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 42, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(result.ok).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('skips the call entirely and passes when the PR has no files', async () => {
    mockGetPrFiles.mockResolvedValue([]);
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 42, vtid: 'VTID-DEV-AUTOPILOT' });
    expect(result).toEqual({ ok: true, passed: true, summary: 'no files changed — nothing to review' });
    expect(mockCallViaRouter).not.toHaveBeenCalled();
  });
});
