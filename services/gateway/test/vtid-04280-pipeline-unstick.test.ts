/**
 * VTID-04280 — the Dev Autopilot pipeline no longer starves itself.
 *
 *  1. lazyPlanTick plans findings BELOW a wall of already-planned rows
 *     (live 2026-09-22: 12 planned rows filled the old 12-row window and 5
 *     planless low/medium findings were never reached).
 *  2. A PR the bridge closed itself (or a human closed) stops counting as
 *     "stranded" once `pr_closed_unmerged_at` is on the execution row.
 */
jest.mock('../src/services/dev-autopilot-planning', () => ({
  extractFilePaths: jest.fn(() => []),
  generatePlanVersion: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  selectPlanlessCandidates,
  selectPlannedCandidates,
  isRealCiClose,
  classifyPrState,
  chunkIds,
  STRANDED_PR_FILTER,
  prNumberOf,
} from '../src/services/dev-autopilot-pipeline-guards';
import { lazyPlanTick, closedPrReconcileTick } from '../src/services/dev-autopilot-execute';
import { generatePlanVersion } from '../src/services/dev-autopilot-planning';

type Route = { match: (url: string, init?: RequestInit) => boolean; body: unknown };
const calls: Array<{ url: string; init?: RequestInit }> = [];
function mockFetch(routes: Route[]) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes.find((x) => x.match(url, init));
    const body = r ? r.body : [];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  });
}

beforeEach(() => {
  calls.length = 0;
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  (generatePlanVersion as jest.Mock).mockClear();
});

describe('VTID-04280 pure helpers', () => {
  it('selectPlanlessCandidates keeps order and drops planned ids', () => {
    const c = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(selectPlanlessCandidates(c, ['a', 'c']).map((x) => x.id)).toEqual(['b', 'd']);
    expect(selectPlannedCandidates(c, ['c', 'a']).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('isRealCiClose is true only for a real CI-stage close', () => {
    expect(isRealCiClose('ci', 'https://github.com/o/r/pull/3544#closed')).toBe(true);
    expect(isRealCiClose('ci', 'https://github.com/o/r/pull/3544#closed-dry-run')).toBe(false);
    expect(isRealCiClose('deploy', 'https://github.com/o/r/pull/3544#closed')).toBe(false);
    expect(isRealCiClose('ci', 'https://github.com/o/r/pull/99')).toBe(false);
    expect(isRealCiClose('ci', undefined)).toBe(false);
  });

  it('classifyPrState distinguishes merged from closed-unmerged', () => {
    expect(classifyPrState({ state: 'closed', merged: false })).toBe('closed_unmerged');
    expect(classifyPrState({ state: 'closed', merged: true })).toBe('merged');
    expect(classifyPrState({ state: 'open', merged: false })).toBe('open');
    expect(classifyPrState(null)).toBe('unknown');
  });

  it('prNumberOf falls back to the pr_url (the #3570 row has no pr_number)', () => {
    expect(prNumberOf({ pr_number: null, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3570' })).toBe(3570);
    expect(prNumberOf({ pr_number: 12, pr_url: 'https://github.com/o/r/pull/99' })).toBe(12);
    expect(prNumberOf({ pr_number: null, pr_url: 'https://github.com/o/r/pull/3544#closed' })).toBe(3544);
    expect(prNumberOf({ pr_number: null, pr_url: null })).toBeNull();
  });

  it('chunkIds bounds each in.() list', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    expect(chunkIds(ids).map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it('STRANDED_PR_FILTER excludes rows stamped closed-unmerged', () => {
    expect(STRANDED_PR_FILTER).toContain('&metadata->>pr_closed_unmerged_at=is.null');
    expect(STRANDED_PR_FILTER).toContain('&status=not.in.(completed,self_healed,auto_archived)');
  });
});

describe('VTID-04280 lazyPlanTick reaches planless findings below planned ones', () => {
  it('plans the planless rows even when the 12 highest-impact rows are already planned', async () => {
    const planned = Array.from({ length: 12 }, (_, i) => ({ id: `planned-${i}` }));
    const planless = [{ id: 'todo-1' }, { id: 'dead-2' }, { id: 'flag-3' }, { id: 'tests-4' }];
    mockFetch([
      { match: (u) => u.includes('/dev_autopilot_config'), body: [{ id: 1, kill_switch: false, daily_budget: 500, concurrency_cap: 4 }] },
      { match: (u) => u.includes('/dev_autopilot_worker_queue'), body: [] },
      { match: (u) => u.includes('/autopilot_recommendations?'), body: [...planned, ...planless] },
      { match: (u) => u.includes('/dev_autopilot_plan_versions?finding_id=in.('), body: planned.map((p) => ({ finding_id: p.id })) },
      { match: (u) => u.includes('/self_healing_log'), body: [] },
    ]);
    await lazyPlanTick();
    const plannedIds = (generatePlanVersion as jest.Mock).mock.calls.map((c) => c[0]);
    expect(plannedIds).toEqual(['todo-1', 'dead-2', 'flag-3']);
    const candidateQuery = calls.find((c) => c.url.includes('/autopilot_recommendations?'))!.url;
    expect(candidateQuery).toContain('limit=200');
  });

  it('skips the tick when the plan lookup fails rather than re-planning everything', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      const fail = url.includes('/dev_autopilot_plan_versions');
      const body = url.includes('/dev_autopilot_config') ? [{ id: 1, kill_switch: false }]
        : url.includes('/autopilot_recommendations?') ? [{ id: 'x' }] : [];
      return { ok: !fail, status: fail ? 500 : 200, json: async () => body, text: async () => 'boom', headers: { get: () => null } } as unknown as Response;
    });
    await lazyPlanTick();
    expect(generatePlanVersion).not.toHaveBeenCalled();
  });
});

describe('VTID-04280 closedPrReconcileTick', () => {
  it('stamps closed-unmerged PRs, records merged/open PRs without unblocking them', async () => {
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'ghs_test';
    mockFetch([
      {
        match: (u, i) => u.includes('/dev_autopilot_executions?pr_url=not.is.null') && (!i || !i.method || i.method === 'GET'),
        body: [
          { id: 'e1', pr_number: 3544, metadata: { error: 'x' } },
          { id: 'e2', pr_number: null, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3570', metadata: null },
          { id: 'e3', pr_number: 3600, metadata: null },
        ],
      },
      { match: (u) => u.endsWith('/pulls/3544'), body: { state: 'closed', merged: false, closed_at: '2026-09-21T19:25:00Z' } },
      { match: (u) => u.endsWith('/pulls/3570'), body: { state: 'closed', merged: true, closed_at: '2026-09-22T17:00:00Z' } },
      { match: (u) => u.endsWith('/pulls/3600'), body: { state: 'open', merged: false, closed_at: null } },
    ]);
    const res = await closedPrReconcileTick(Date.parse('2026-09-22T20:00:00Z'));
    expect(res).toEqual({ checked: 3, stamped: 1 });
    const patches = calls.filter((c) => c.init?.method === 'PATCH');
    const byId = (id: string) => JSON.parse(String(patches.find((p) => p.url.includes(`id=eq.${id}`))!.init!.body));
    expect(byId('e1').metadata.pr_closed_unmerged_at).toBe('2026-09-21T19:25:00Z');
    expect(byId('e1').metadata.error).toBe('x');
    expect(byId('e1').status).toBeUndefined();
    expect(byId('e2').metadata.pr_closed_unmerged_at).toBeUndefined();
    expect(byId('e2').metadata.pr_state).toBe('merged');
    expect(byId('e3').metadata.pr_closed_unmerged_at).toBeUndefined();
    expect(byId('e3').metadata.pr_state_checked_at).toBe('2026-09-22T20:00:00.000Z');
  });

  it('is rate-limited to once per 5 minutes', async () => {
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'ghs_test';
    mockFetch([]);
    const t = Date.parse('2026-09-23T10:00:00Z');
    await closedPrReconcileTick(t);
    calls.length = 0;
    const second = await closedPrReconcileTick(t + 60_000);
    expect(second).toEqual({ checked: 0, stamped: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('VTID-04280 wiring (source contract)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  const bridge = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-bridge.ts'), 'utf8');

  it('all three PR-flood guards use the shared filter', () => {
    expect(src.match(/\+ STRANDED_PR_FILTER/g)?.length).toBe(3);
    expect(src).not.toMatch(/&pr_url=not\.is\.null`\s*\n\s*\+ `&status=not\.in\.\(completed,self_healed,auto_archived\)`/);
  });

  it('autoApproveTick reads a wide window and pre-filters to planned findings', () => {
    const tick = src.slice(src.indexOf('export async function autoApproveTick('), src.indexOf('// Second pass: IMPACT findings.'));
    expect(tick).toContain('limit=${AUTO_APPROVE_CANDIDATE_WINDOW}');
    expect(tick).toContain('selectPlannedCandidates(findingsR.data, plannedIds)');
  });

  it('the closed-PR reconcile tick runs on the background ticker', () => {
    const ticker = src.slice(src.indexOf('export function startBackgroundExecutor('));
    expect(ticker).toContain('closedPrReconcileTick()');
  });

  it('the bridge stamps its own CI-stage close on the row', () => {
    expect(bridge).toMatch(/isRealCiClose\(input\.failure_stage, revert\.revert_pr_url\)[\s\S]{0,80}PR_CLOSED_UNMERGED_KEY/);
  });
});
