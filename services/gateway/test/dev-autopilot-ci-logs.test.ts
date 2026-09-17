/**
 * VTID-04005: GitHub Actions job-log evidence for CI failures.
 */

import {
  CI_LOG_EXCERPT_MAX_CHARS,
  CI_LOG_MAX_JOBS,
  collectCiFailureEvidence,
  extractLogExcerpt,
  parseActionsJobId,
  renderCiEvidence,
} from '../src/services/dev-autopilot-ci-logs';

describe('VTID-04005 parseActionsJobId', () => {
  it('extracts the job id from an Actions check-run details_url', () => {
    expect(parseActionsJobId('https://github.com/exafyltd/vitana-platform/actions/runs/35254869744/job/105315905758')).toBe(105315905758);
  });
  it('returns null for non-Actions urls and empty input', () => {
    expect(parseActionsJobId('https://example.com/status/1')).toBeNull();
    expect(parseActionsJobId(null)).toBeNull();
    expect(parseActionsJobId(undefined)).toBeNull();
  });
});

describe('VTID-04005 extractLogExcerpt', () => {
  const ts = (i: number) => `2026-09-17T17:49:${String(i % 60).padStart(2, '0')}.1234567Z `;

  it('strips Actions timestamps and group markers', () => {
    const raw = `${ts(1)}##[group]Run npm test\n${ts(2)}npm test\n${ts(3)}##[endgroup]\n${ts(4)}PASS test/a.test.ts`;
    const out = extractLogExcerpt(raw);
    expect(out).not.toMatch(/2026-09-17T/);
    expect(out).not.toMatch(/##\[group\]/);
    expect(out).toContain('PASS test/a.test.ts');
  });

  it('centres on the first error line and keeps the tail summary', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`${ts(i)}noise line ${i}`);
    lines[80] = `${ts(80)}src/services/foo.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.`;
    lines.push(`${ts(0)}Tests: 1 failed, 40 passed`);
    lines.push(`${ts(1)}##[error]Process completed with exit code 1.`);
    const out = extractLogExcerpt(lines.join('\n'));
    expect(out).toContain('error TS2322');
    expect(out).toContain('noise line 78'); // 3 lines of pre-context
    expect(out).toContain('Tests: 1 failed, 40 passed');
    expect(out).toContain('Process completed with exit code 1');
    expect(out).not.toContain('noise line 10\n'); // middle noise dropped
    expect(out.length).toBeLessThanOrEqual(CI_LOG_EXCERPT_MAX_CHARS);
  });

  it('falls back to the tail when no signal line exists, and honours the budget', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `${ts(i)}line ${i} ${'x'.repeat(40)}`).join('\n');
    const out = extractLogExcerpt(raw, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain('line 499');
  });

  it('returns empty for empty input', () => {
    expect(extractLogExcerpt('')).toBe('');
  });
});

describe('VTID-04005 renderCiEvidence', () => {
  it('renders one block per job and truncates to the budget', () => {
    const txt = renderCiEvidence([
      { check_name: 'validate-pr', job_id: 1, excerpt: 'exit 10: no VTID' },
      { check_name: 'unit', job_id: 2, excerpt: 'x'.repeat(10_000) },
    ], 500);
    expect(txt).toContain('--- validate-pr (job 1) ---');
    expect(txt).toContain('exit 10: no VTID');
    expect(txt.length).toBeLessThanOrEqual(500 + 20);
    expect(txt).toMatch(/\[truncated\]$/);
  });
  it('is empty for no excerpts', () => {
    expect(renderCiEvidence([])).toBe('');
  });

  // VTID-04008: Tests for totalFailing parameter
  it('appends unfetched count when totalFailing > excerpts.length', () => {
    const excerpts = [
      { check_name: 'check-a', job_id: 1, excerpt: 'error in a' },
      { check_name: 'check-b', job_id: 2, excerpt: 'error in b' },
      { check_name: 'check-c', job_id: 3, excerpt: 'error in c' },
    ];
    const txt = renderCiEvidence(excerpts, 10000, 7);
    expect(txt).toContain('--- check-a (job 1) ---');
    expect(txt).toContain('--- check-b (job 2) ---');
    expect(txt).toContain('--- check-c (job 3) ---');
    expect(txt).toContain(`…and 4 more failing check(s) not fetched (cap CI_LOG_MAX_JOBS=${CI_LOG_MAX_JOBS})`);
  });

  it('does not append unfetched line when totalFailing equals excerpts.length', () => {
    const excerpts = [
      { check_name: 'check-a', job_id: 1, excerpt: 'error in a' },
      { check_name: 'check-b', job_id: 2, excerpt: 'error in b' },
    ];
    const withTotal = renderCiEvidence(excerpts, 10000, 2);
    const withoutTotal = renderCiEvidence(excerpts, 10000);
    expect(withTotal).toBe(withoutTotal);
    expect(withTotal).not.toContain('more failing check(s) not fetched');
  });

  it('does not append unfetched line when totalFailing is omitted', () => {
    const excerpts = [
      { check_name: 'check-a', job_id: 1, excerpt: 'error in a' },
    ];
    const txt = renderCiEvidence(excerpts, 10000);
    expect(txt).not.toContain('more failing check(s) not fetched');
  });

  it('does not append unfetched line when totalFailing < excerpts.length', () => {
    const excerpts = [
      { check_name: 'check-a', job_id: 1, excerpt: 'error in a' },
      { check_name: 'check-b', job_id: 2, excerpt: 'error in b' },
    ];
    const txt = renderCiEvidence(excerpts, 10000, 1);
    expect(txt).not.toContain('more failing check(s) not fetched');
  });

  it('returns empty string for empty excerpts even with totalFailing > 0', () => {
    expect(renderCiEvidence([], 10000, 5)).toBe('');
  });

  it('respects maxChars budget including the unfetched line', () => {
    const excerpts = [
      { check_name: 'check-a', job_id: 1, excerpt: 'x'.repeat(400) },
    ];
    const txt = renderCiEvidence(excerpts, 300, 10);
    expect(txt.length).toBeLessThanOrEqual(300 + 20); // +20 for truncated marker
    expect(txt).toMatch(/\[truncated\]$/);
  });
});

describe('VTID-04005 collectCiFailureEvidence', () => {
  const base = { owner: 'exafyltd', repo: 'vitana-platform', headSha: 'abc123', token: 'tok' };

  it('fetches logs only for the failing checks named, capped at CI_LOG_MAX_JOBS', async () => {
    const runs = ['a', 'b', 'c', 'd', 'e'].map((n, i) => ({
      name: n,
      conclusion: 'failure',
      details_url: `https://github.com/x/y/actions/runs/1/job/${100 + i}`,
    }));
    runs.push({ name: 'green', conclusion: 'success', details_url: 'https://github.com/x/y/actions/runs/1/job/999' });
    const fetchJobLog = jest.fn(async (_o: string, _r: string, id: number) => `job ${id}\nerror: boom ${id}`);
    const out = await collectCiFailureEvidence({
      ...base,
      failedNames: ['a', 'b', 'c', 'd', 'e', 'green'],
      fetchCheckRuns: async () => runs,
      fetchJobLog,
    });
    expect(out).toHaveLength(CI_LOG_MAX_JOBS);
    expect(fetchJobLog).toHaveBeenCalledTimes(CI_LOG_MAX_JOBS);
    expect(out[0]).toMatchObject({ check_name: 'a', job_id: 100 });
    expect(out[0].excerpt).toContain('error: boom 100');
    expect(out.map((e) => e.check_name)).not.toContain('green');
  });

  it('marks a job whose log fetch fails as unavailable instead of throwing', async () => {
    const out = await collectCiFailureEvidence({
      ...base,
      failedNames: ['validate-pr'],
      fetchCheckRuns: async () => [{ name: 'validate-pr', conclusion: 'failure', details_url: 'https://github.com/x/y/actions/runs/1/job/7' }],
      fetchJobLog: async () => { throw new Error('GitHub 410'); },
    });
    expect(out).toEqual([expect.objectContaining({ check_name: 'validate-pr', job_id: 7, unavailable: true })]);
    expect(out[0].excerpt).toContain('GitHub 410');
  });

  it('reports a check-run with no Actions job id (external status) as unavailable', async () => {
    const out = await collectCiFailureEvidence({
      ...base,
      failedNames: ['codecov'],
      fetchCheckRuns: async () => [{ name: 'codecov', conclusion: 'failure', details_url: 'https://codecov.io/gh/x/y' }],
      fetchJobLog: async () => 'never called',
    });
    expect(out[0].unavailable).toBe(true);
    expect(out[0].job_id).toBe(0);
  });

  it('returns [] when the check-run listing itself fails or the token is missing', async () => {
    const out = await collectCiFailureEvidence({
      ...base,
      failedNames: ['x'],
      fetchCheckRuns: async () => { throw new Error('502'); },
    });
    expect(out).toEqual([]);
    const prev = process.env.GITHUB_SAFE_MERGE_TOKEN;
    delete process.env.GITHUB_SAFE_MERGE_TOKEN;
    try {
      expect(await collectCiFailureEvidence({ owner: 'o', repo: 'r', headSha: 's', failedNames: ['x'] })).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.GITHUB_SAFE_MERGE_TOKEN = prev;
    }
  });
});