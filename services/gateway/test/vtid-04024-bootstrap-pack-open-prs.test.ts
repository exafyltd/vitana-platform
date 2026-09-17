/**
 * VTID-04024: the operator bootstrap pack's open-PR source timed out live on
 * the first W4a staging turn ("(unavailable: Open pull requests timed out
 * after 2500ms)"). Pins the fix: listOpenPrsWithStatus runs its per-PR CI
 * lookups concurrently and carries the PR title; the pack races the
 * enriched list against a partial budget and falls back to the one-call
 * bare list (marked degraded) instead of rendering the section unavailable.
 */

jest.mock('node-fetch');

import {
  OPEN_PRS_ENRICH_BUDGET_MS, OPEN_PRS_FALLBACK_NOTE, SOURCE_TIMEOUT_MS,
  buildBootstrapSections, resolvePlatformOpenPrs, type BootstrapDeps, type OpenPrSummary,
} from '../src/services/operator-bootstrap-pack';
import { listOpenPrsBare, listOpenPrsWithStatus } from '../src/services/github-service';

const P = 'exafyltd/vitana-platform';
const rich: OpenPrSummary[] = [{ repo: P, number: 3392, title: 'W5a dev_cloudwatch_logs', branch: 'claude/x', ci: 'pass', mergeable: true }];
const bare: OpenPrSummary[] = [{ repo: P, number: 3392, title: 'W5a dev_cloudwatch_logs', branch: 'claude/x' }, { repo: P, number: 3390, title: 'Handoff', branch: 'claude/y' }];
const hang = () => new Promise<never>(() => undefined);

function deps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    readRepoFile: async (path) => (path === 'CLAUDE.md' ? '# PART 1: CORE RULES\n\n1. x\n\n---\n\n# PART 2\n\n## CHANGE LOG\n\n| Date | Change | VTID |\n|---|---|---|\n| 2026-09-17 | **a** | VTID-04024 |\n' : path.endsWith('.json') ? '{"services":{}}' : '### t1\n'),
    listPlatformOpenPrs: async () => rich,
    listPlatformOpenPrsBare: async () => bare,
    listFrontendOpenPrs: async () => [],
    queryRecentEvents: async () => [],
    fetchBuildInfo: async () => ({ env: 'staging', git_commit: 'abc' }),
    env: { OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true' },
    ...overrides,
  };
}

describe('VTID-04024 resolvePlatformOpenPrs', () => {
  it('serves the CI-enriched list when it arrives inside the budget', async () => {
    const r = await resolvePlatformOpenPrs({ listPlatformOpenPrs: async () => rich, listPlatformOpenPrsBare: async () => bare }, 200);
    expect(r).toEqual({ items: rich, degraded: false });
  });

  it('falls back to the bare list, marked degraded, when the enriched list is late', async () => {
    const t0 = Date.now();
    const r = await resolvePlatformOpenPrs({ listPlatformOpenPrs: hang, listPlatformOpenPrsBare: async () => bare }, 150);
    expect(r).toEqual({ items: bare, degraded: true });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('falls back to the bare list when the enriched list rejects, and never leaks an unhandled rejection', async () => {
    const r = await resolvePlatformOpenPrs({ listPlatformOpenPrs: async () => { throw new Error('GitHub API error: 502'); }, listPlatformOpenPrsBare: async () => bare }, 150);
    expect(r).toEqual({ items: bare, degraded: true });
  });

  it('throws with both reasons when the bare list fails too, and with the enriched reason when no bare lister exists', async () => {
    await expect(resolvePlatformOpenPrs({ listPlatformOpenPrs: hang, listPlatformOpenPrsBare: async () => { throw new Error('rate limited'); } }, 100))
      .rejects.toThrow(/platform: enriched list exceeded 100ms; bare list: rate limited/);
    await expect(resolvePlatformOpenPrs({ listPlatformOpenPrs: async () => { throw new Error('boom'); } }, 100)).rejects.toThrow('platform: boom');
    await expect(resolvePlatformOpenPrs({ listPlatformOpenPrs: hang }, 100)).rejects.toThrow(/exceeded 100ms/);
  });

  it('the default budget leaves room for the bare call inside the section timeout', () => {
    expect(OPEN_PRS_ENRICH_BUDGET_MS).toBeLessThan(SOURCE_TIMEOUT_MS - 500);
  });
});

describe('VTID-04024 pack section', () => {
  it('lists the PRs with the degraded note instead of "(unavailable: … timed out)" when enrichment hangs', async () => {
    const t0 = Date.now();
    const sections = await buildBootstrapSections(deps({ listPlatformOpenPrs: hang }));
    const s = sections.find((x) => x.title === 'Open pull requests')!;
    expect(s.error).toBeUndefined();
    expect(s.body).toContain(`- ${P}#3392 W5a dev_cloudwatch_logs [claude/x]`);
    expect(s.body).toContain(`- ${P}#3390 Handoff`);
    expect(s.body).toContain(OPEN_PRS_FALLBACK_NOTE);
    expect(Date.now() - t0).toBeLessThan(SOURCE_TIMEOUT_MS);
  });

  it('renders ci/mergeable flags and no note on the normal path', async () => {
    const sections = await buildBootstrapSections(deps());
    const s = sections.find((x) => x.title === 'Open pull requests')!;
    expect(s.body).toContain('(ci=pass, mergeable)');
    expect(s.body).not.toContain(OPEN_PRS_FALLBACK_NOTE);
  });

  it('without a bare lister the section still degrades to unavailable (pre-VTID-04024 shape) rather than hanging', async () => {
    const sections = await buildBootstrapSections(deps({ listPlatformOpenPrs: hang, listPlatformOpenPrsBare: undefined }));
    expect(sections.find((x) => x.title === 'Open pull requests')!.error).toMatch(/exceeded/);
  });
});

describe('VTID-04024 github-service', () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_FETCH = (global as any).fetch;
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, GITHUB_SAFE_MERGE_TOKEN: 'test-token' }; jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { (global as any).fetch = ORIGINAL_FETCH; jest.restoreAllMocks(); });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  const prs = [3392, 3390, 3388].map((n) => ({ number: n, html_url: `https://github.com/${P}/pull/${n}`, title: `PR ${n} title`, state: 'open', head: { ref: `b${n}`, sha: `sha${n}` }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', updated_at: '2026-09-17T21:00:00Z' }));

  function installFetch(perCallDelayMs: number) {
    const calls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      calls.push(url);
      const body = url.includes('/pulls?') ? prs : url.includes('/check-runs') ? { total_count: 0, check_runs: [] } : { state: 'success', statuses: [] };
      if (!url.includes('/pulls?')) await new Promise((r) => setTimeout(r, perCallDelayMs));
      return { ok: true, status: 200, statusText: 'OK', headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify(body), json: async () => body };
    });
    return calls;
  }

  it('listOpenPrsWithStatus runs the per-PR CI lookups concurrently and carries the PR title', async () => {
    const calls = installFetch(250);
    const t0 = Date.now();
    const items = await listOpenPrsWithStatus(P, 20);
    const elapsed = Date.now() - t0;
    expect(items.map((i) => [i.pr_number, i.title])).toEqual([[3392, 'PR 3392 title'], [3390, 'PR 3390 title'], [3388, 'PR 3388 title']]);
    expect(calls.filter((c) => !c.includes('/pulls?')).length).toBeGreaterThanOrEqual(3);
    // Sequential per-PR enrichment would take >= 3 × 250 ms; concurrent takes ~250 ms.
    expect(elapsed).toBeLessThan(600);
  });

  it('listOpenPrsBare is one call and carries number/title/branch', async () => {
    const calls = installFetch(0);
    const items = await listOpenPrsBare(P, 20);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/repos/${P}/pulls?state=open`);
    expect(items[0]).toEqual({ number: 3392, title: 'PR 3392 title', branch: 'b3392', url: `https://github.com/${P}/pull/3392`, updated_at: '2026-09-17T21:00:00Z' });
  });
});
