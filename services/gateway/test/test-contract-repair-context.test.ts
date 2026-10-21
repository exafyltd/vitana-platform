/**
 * VTID-02967 (PR-L4): Unit tests for the known-good recovery context
 * builder. Pure logic + recommendation thresholds.
 *
 * The networked GitHub Contents API path is exercised by mocking
 * fetchFromGithub; the recommendation heuristic is tested directly.
 */

import {
  recommendAction,
  buildRepairContext,
  renderRepairContextMarkdown,
} from '../src/services/test-contract-repair-context';

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  process.env.GITHUB_SAFE_MERGE_TOKEN = 'gh-token';
  process.env.GITHUB_REPO_OWNER = 'exafyltd';
  process.env.GITHUB_REPO_NAME = 'vitana-platform';
  delete process.env.DEPLOYED_GIT_SHA;
  delete process.env.BUILD_SHA;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

// =============================================================================
// recommendAction — pure heuristic
// =============================================================================

describe('recommendAction', () => {
  it('no target_file → no_known_good', () => {
    const r = recommendAction(false, true, false, false, null);
    expect(r.action).toBe('no_known_good');
    expect(r.rationale).toContain('no target_file');
  });

  it('no last_passing_sha → no_known_good (first failure cycle)', () => {
    const r = recommendAction(true, false, false, false, null);
    expect(r.action).toBe('no_known_good');
    expect(r.rationale).toContain('no last_passing_sha');
  });

  it('SHA known but content unfetchable → investigate', () => {
    const r = recommendAction(true, true, false, false, null);
    expect(r.action).toBe('investigate');
    expect(r.rationale).toContain('unfetchable');
  });

  it('tiny diff (≤ 10 lines) → recover_to_last_passing_sha (revert is safe default)', () => {
    const r = recommendAction(true, true, true, true, 3);
    expect(r.action).toBe('recover_to_last_passing_sha');
    expect(r.rationale).toContain('tiny diff');
  });

  it('moderate diff (11–60 lines) → compensate', () => {
    const r = recommendAction(true, true, true, true, 25);
    expect(r.action).toBe('compensate');
    expect(r.rationale).toContain('moderate diff');
  });

  it('large diff (> 60 lines) → investigate', () => {
    const r = recommendAction(true, true, true, true, 120);
    expect(r.action).toBe('investigate');
    expect(r.rationale).toContain('large diff');
  });

  it('uses absolute value for delta — file SHRINKING by N lines is the same as growing by N for revert decision', () => {
    expect(recommendAction(true, true, true, true, -5).action).toBe('recover_to_last_passing_sha');
    expect(recommendAction(true, true, true, true, -25).action).toBe('compensate');
  });

  it('boundary: delta=10 → recover (≤ 10), delta=11 → compensate', () => {
    expect(recommendAction(true, true, true, true, 10).action).toBe('recover_to_last_passing_sha');
    expect(recommendAction(true, true, true, true, 11).action).toBe('compensate');
  });

  it('boundary: delta=60 → compensate, delta=61 → investigate', () => {
    expect(recommendAction(true, true, true, true, 60).action).toBe('compensate');
    expect(recommendAction(true, true, true, true, 61).action).toBe('investigate');
  });
});

// =============================================================================
// buildRepairContext — uses fetch mock to simulate GitHub Contents API
// =============================================================================

describe('buildRepairContext', () => {
  function mockGithub(
    files: Record<string, { content: string; sha: string }>,
  ) {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      // GitHub Contents API URL format:
      //   https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<ref>
      const m = url.match(/\/contents\/([^?]+)\?ref=([^&]+)/);
      if (!m) return new Response('{}', { status: 404 });
      const filePath = decodeURIComponent(m[1].split('/').map(decodeURIComponent).join('/'));
      const ref = decodeURIComponent(m[2]);
      const key = `${ref}:${filePath}`;
      const file = files[key];
      if (!file) return new Response(JSON.stringify({}), { status: 404 });
      return new Response(
        JSON.stringify({
          content: Buffer.from(file.content, 'utf-8').toString('base64'),
          encoding: 'base64',
          sha: file.sha,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  it('returns has_known_good=false + no_known_good action when last_passing_sha is null', async () => {
    const ctx = await buildRepairContext({
      targetFile: 'services/gateway/src/routes/auth.ts',
      lastPassingSha: null,
    });
    expect(ctx.has_known_good).toBe(false);
    expect(ctx.recommended_action).toBe('no_known_good');
    expect(ctx.last_passing_content).toBeNull();
    expect(ctx.current_content).toBeNull();
  });

  it('returns has_known_good=false + no_known_good action when target_file is null', async () => {
    const ctx = await buildRepairContext({ targetFile: null, lastPassingSha: 'abc1234' });
    expect(ctx.has_known_good).toBe(false);
    expect(ctx.recommended_action).toBe('no_known_good');
  });

  it('fetches last_passing + current and recommends recover when diff is tiny', async () => {
    process.env.DEPLOYED_GIT_SHA = 'currentsha';
    const lp = 'line1\nline2\nline3\nline4\nline5';
    const cur = 'line1\nline2\nline3-CHANGED\nline4\nline5';
    mockGithub({
      'oldsha:src/x.ts': { content: lp, sha: 'oldsha' },
      'currentsha:src/x.ts': { content: cur, sha: 'currentsha' },
    });
    const ctx = await buildRepairContext({ targetFile: 'src/x.ts', lastPassingSha: 'oldsha' });
    expect(ctx.has_known_good).toBe(true);
    expect(ctx.last_passing_content).toBe(lp);
    expect(ctx.current_content).toBe(cur);
    expect(ctx.delta_lines).toBe(0); // same line count, just edited
    expect(ctx.recommended_action).toBe('recover_to_last_passing_sha');
  });

  it('falls back to ref=main when DEPLOYED_GIT_SHA is unset', async () => {
    // Mock getDeployedSha to actually return null. (Without this the
    // BUILD_INFO file in services/gateway/ would be read by the
    // re-imported module, returning a real SHA.)
    jest.resetModules();
    jest.doMock('../src/services/self-healing-diagnosis-service', () => ({
      __esModule: true,
      getDeployedSha: () => null,
      fetchFromGithub: jest.fn().mockImplementation(async (rel: string, ref: string) => {
        const map: Record<string, string> = { 'oldsha:f.ts': 'old', 'main:f.ts': 'new' };
        const content = map[`${ref}:${rel}`];
        if (!content) return { ok: false };
        return { ok: true, content, sha: ref };
      }),
    }));
    const reloaded = require('../src/services/test-contract-repair-context');
    const ctx = await reloaded.buildRepairContext({ targetFile: 'f.ts', lastPassingSha: 'oldsha' });
    expect(ctx.has_known_good).toBe(true);
    expect(ctx.current_content).toBe('new');
    expect(ctx.current_sha).toBeNull(); // no DEPLOYED_GIT_SHA
  });

  it('records fetch_errors when last_passing fetch misses', async () => {
    process.env.DEPLOYED_GIT_SHA = 'currentsha';
    mockGithub({
      // last_passing missing
      'currentsha:f.ts': { content: 'cur', sha: 'currentsha' },
    });
    const ctx = await buildRepairContext({ targetFile: 'f.ts', lastPassingSha: 'oldsha' });
    expect(ctx.has_known_good).toBe(false);
    expect(ctx.recommended_action).toBe('investigate');
    expect(ctx.fetch_errors).toEqual(['fetch_last_passing_failed:oldsha']);
    expect(ctx.last_passing_content).toBeNull();
    expect(ctx.current_content).toBe('cur');
  });

  it('truncates content over 16 KB to keep spec_markdown bounded', async () => {
    process.env.DEPLOYED_GIT_SHA = 'currentsha';
    const huge = 'x'.repeat(40_000);
    mockGithub({
      'oldsha:big.ts': { content: huge, sha: 'oldsha' },
      'currentsha:big.ts': { content: 'small', sha: 'currentsha' },
    });
    const ctx = await buildRepairContext({ targetFile: 'big.ts', lastPassingSha: 'oldsha' });
    expect(ctx.last_passing_content!.length).toBeLessThan(17_000);
    expect(ctx.last_passing_content!).toContain('truncated to 16384 bytes');
  });

  it('computes delta_lines correctly when current adds lines', async () => {
    process.env.DEPLOYED_GIT_SHA = 'currentsha';
    mockGithub({
      'oldsha:f.ts': { content: 'a\nb\nc', sha: 'oldsha' },
      'currentsha:f.ts': { content: 'a\nb\nc\nd\ne\nf\ng\nh', sha: 'currentsha' },
    });
    const ctx = await buildRepairContext({ targetFile: 'f.ts', lastPassingSha: 'oldsha' });
    expect(ctx.last_passing_line_count).toBe(3);
    expect(ctx.current_line_count).toBe(8);
    expect(ctx.delta_lines).toBe(5);
    // 5 lines is still ≤ 10 → recover
    expect(ctx.recommended_action).toBe('recover_to_last_passing_sha');
  });

  it('large diff promotes investigate action', async () => {
    process.env.DEPLOYED_GIT_SHA = 'currentsha';
    const small = Array(5).fill('line').join('\n');
    const huge = Array(200).fill('line').join('\n');
    mockGithub({
      'oldsha:f.ts': { content: small, sha: 'oldsha' },
      'currentsha:f.ts': { content: huge, sha: 'currentsha' },
    });
    const ctx = await buildRepairContext({ targetFile: 'f.ts', lastPassingSha: 'oldsha' });
    expect(ctx.delta_lines).toBe(195);
    expect(ctx.recommended_action).toBe('investigate');
  });
});

// =============================================================================
// renderRepairContextMarkdown — section heading + structure
// =============================================================================

describe('renderRepairContextMarkdown', () => {
  it('produces a "_Not available._" stub when has_known_good=false', () => {
    const md = renderRepairContextMarkdown({
      has_known_good: false,
      target_file: null,
      last_passing_sha: null,
      current_sha: null,
      last_passing_content: null,
      current_content: null,
      last_passing_line_count: null,
      current_line_count: null,
      delta_lines: null,
      recommended_action: 'no_known_good',
      recommendation_rationale: 'no last_passing_sha recorded yet',
      fetch_errors: [],
    });
    expect(md).toContain('Known-good recovery context');
    expect(md).toContain('_Not available._');
    expect(md).toContain('no_known_good');
  });

  it('renders both file versions + diff summary when has_known_good=true', () => {
    const md = renderRepairContextMarkdown({
      has_known_good: true,
      target_file: 'src/x.ts',
      last_passing_sha: 'abcdef0123',
      current_sha: 'fedcba9876',
      last_passing_content: 'old code',
      current_content: 'new code',
      last_passing_line_count: 1,
      current_line_count: 1,
      delta_lines: 0,
      recommended_action: 'recover_to_last_passing_sha',
      recommendation_rationale: 'tiny diff',
      fetch_errors: [],
    });
    expect(md).toContain('1 → 1 lines');
    expect(md).toContain('delta +0');
    expect(md).toContain('Last passing content');
    expect(md).toContain('Current content');
    expect(md).toContain('old code');
    expect(md).toContain('new code');
    expect(md).toContain('recover_to_last_passing_sha');
  });

  it('renders negative delta with the minus sign (file shrunk)', () => {
    const md = renderRepairContextMarkdown({
      has_known_good: true,
      target_file: 'src/x.ts',
      last_passing_sha: 'abc',
      current_sha: 'def',
      last_passing_content: 'a\nb\nc',
      current_content: 'a',
      last_passing_line_count: 3,
      current_line_count: 1,
      delta_lines: -2,
      recommended_action: 'recover_to_last_passing_sha',
      recommendation_rationale: 'tiny',
      fetch_errors: [],
    });
    // Should NOT have a leading + on negative numbers
    expect(md).toContain('delta -2');
    expect(md).not.toContain('delta +-2');
  });
});
