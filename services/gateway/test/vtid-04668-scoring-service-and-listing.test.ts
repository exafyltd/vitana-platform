/**
 * VTID-04668 (P2): writing the score (after insert + rescore tick), fail-open
 * behaviour, and how the developer listings order and filter by it.
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');
jest.mock('../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
  countActiveUsageDays: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/services/dev-autopilot-planning', () => ({
  generatePlanVersion: jest.fn(),
  eagerlyPlanTopK: jest.fn().mockResolvedValue({ planned: 0, errors: 0 }),
}));
jest.mock('../src/services/dev-autopilot-execute', () => ({
  approveAutoExecute: jest.fn(),
  cancelExecution: jest.fn(),
}));
jest.mock('../src/services/dev-autopilot-bridge', () => ({ bridgeFailureToSelfHealing: jest.fn() }));
jest.mock('../src/services/dev-autopilot-self-heal-log', () => ({ writeAutopilotFailure: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/dev-autopilot-safety', () => ({ dryRunPreflight: jest.fn() }));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));
jest.mock('../src/services/dev-autopilot-outcomes', () => ({
  recordOutcome: jest.fn().mockResolvedValue(undefined),
  summarizeSpendToday: jest.fn(),
}));

const SCAN_TOKEN = 'test-scan-token-04668';
process.env.DEV_AUTOPILOT_SCAN_TOKEN = SCAN_TOKEN;
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
// P3 (VTID-04669) filters unreviewed rows; this suite pins the P2 contract.
process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED = 'false';

import * as breakerModule from '../src/services/dev-autopilot-scanner-breaker';
import {
  buildScorePatch,
  loadScoringContext,
  rescoreTick,
  resetScoringServiceState,
  scoreNewDeveloperRecommendations,
  scoreRows,
  RESCORE_EVERY_MS,
} from '../src/services/recommendation-quality/scoring-service';
import { applyDeveloperQualityListing, sortByPriority } from '../src/services/recommendation-quality/listing';
import { comparePendingApprovals } from '../src/services/dev-recommendation-policy';
import { ingestScan } from '../src/services/dev-autopilot-synthesis';
import { queryRecommendationsByRole } from '../src/routes/autopilot-recommendations';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/dev-autopilot').default;
const app = express();
app.use(express.json());
app.use('/api/v1/dev-autopilot', router);

const fetchMock = global.fetch as jest.Mock;
function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}
type Handler = (url: string, opts: any) => any | undefined;
function route(handler: Handler) {
  fetchMock.mockImplementation((url: any, opts: any = {}) => {
    const r = handler(String(url), opts || {});
    return Promise.resolve(r !== undefined ? r : jsonRes(200, []));
  });
}
const method = (opts: any) => (opts && opts.method) || 'GET';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  source_type: 'dev_autopilot',
  user_id: null,
  status: 'new',
  risk_class: 'medium',
  seen_count: 2,
  last_seen_at: new Date(NOW).toISOString(),
  spec_snapshot: { signal_type: 'missing_auth', scanner: 'route-auth-scanner-v1', file_path: 'services/gateway/src/routes/x.ts' },
  quality: null,
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  resetScoringServiceState();
  breakerModule.resetScannerBreakerCache();
  process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
  (jose.jwtVerify as jest.Mock).mockResolvedValue({
    payload: { sub: 'dev-admin-1', email: 'dev@example.com', role: 'authenticated', app_metadata: { exafy_admin: true } },
  });
});

describe('scoring writes', () => {
  it('PATCHes priority_score, quality and the legacy impact/effort for developer rows only', async () => {
    const patches: Array<{ path: string; body: any }> = [];
    const r = await scoreRows(
      [row(), row({ id: 'c1', source_type: 'community', user_id: 'u1' }), row({ id: 'o1', source_type: 'operator_onramp' })],
      {
        query: async () => ({ ok: true, data: [] }),
        patch: async (path, body) => { patches.push({ path, body }); return { ok: true }; },
        nowMs: NOW,
      },
    );
    expect(r.scored).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe('/rest/v1/autopilot_recommendations?id=eq.rec-1&user_id=is.null');
    expect(Object.keys(patches[0].body).sort()).toEqual(['effort_score', 'impact_score', 'priority_score', 'quality']);
    expect(patches[0].body.quality.version).toBe(1);
    expect(patches[0].body.impact_score).toBeGreaterThanOrEqual(1);
  });

  it('a rescore keeps the P3 review fields already on the row', () => {
    const body = buildScorePatch(row({ quality: { version: 1, review: { verdict: 'keep' }, review_attempts: 1 } }) as any, { nowMs: NOW });
    expect(body.quality.review).toEqual({ verdict: 'keep' });
    expect(body.quality.review_attempts).toBe(1);
  });

  it('loads success odds through the P4 breaker reader, without its cache or transition events', async () => {
    const spy = jest.spyOn(breakerModule, 'loadScannerBreakers');
    await loadScoringContext({ query: async () => ({ ok: true, data: [] }), nowMs: NOW });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ emitTransitions: false, useCache: false }));
    spy.mockRestore();
  });

  it('scoreNewDeveloperRecommendations reads only unscored open developer rows since the given time', async () => {
    const paths: string[] = [];
    await scoreNewDeveloperRecommendations('2026-09-26T11:59:00.000Z', {
      query: async (p: string) => { paths.push(p); return { ok: true, data: [] }; },
      patch: async () => ({ ok: true }),
    });
    expect(paths[0]).toContain('user_id=is.null');
    expect(paths[0]).toContain('quality=is.null');
    expect(paths[0]).toContain('source_type=not.in.(community,operator_onramp)');
    expect(paths[0]).toContain('created_at=gte.2026-09-26T11%3A59%3A00.000Z');
  });

  it('fail-open: a throwing reader or a failed PATCH never throws to the caller', async () => {
    await expect(scoreNewDeveloperRecommendations('x', { query: async () => { throw new Error('db down'); } })).resolves.toMatchObject({ ok: false });
    const r = await scoreRows([row()], {
      query: async () => { throw new Error('stats down'); },
      patch: async () => ({ ok: false, error: '400 column missing' }),
      nowMs: NOW,
    });
    expect(r).toMatchObject({ ok: true, scored: 0, failed: 1 });
  });

  it('rescoreTick runs at most every 30 minutes and orders oldest score first', async () => {
    const paths: string[] = [];
    const deps = { query: async (p: string) => { paths.push(p); return { ok: true, data: [] }; }, patch: async () => ({ ok: true }) };
    expect(await rescoreTick(NOW, deps)).not.toBeNull();
    expect(await rescoreTick(NOW + 60_000, deps)).toBeNull();
    expect(await rescoreTick(NOW + RESCORE_EVERY_MS, deps)).not.toBeNull();
    expect(paths[0]).toContain('order=quality->>scored_at.asc.nullsfirst');
    expect(paths[0]).toContain('limit=200');
  });

  it('ingestScan still succeeds when scoring cannot read anything (insert never blocked)', async () => {
    const posts: any[] = [];
    route((url, opts) => {
      const m = method(opts);
      if (url.includes('/dev_autopilot_runs')) return jsonRes(m === 'POST' ? 201 : 204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && m === 'POST') { posts.push(JSON.parse(opts.body)); return jsonRes(201, {}); }
      if (url.includes('quality=is.null')) return jsonRes(500, { message: 'column "quality" does not exist' });
      return undefined;
    });
    const res = await ingestScan({ signals: [{ type: 'todo', severity: 'medium', file_path: 'services/gateway/src/a.ts', message: 'TODO x', suggested_action: 'do', scanner: 'todo-scanner-v1' }] });
    expect(res.ok).toBe(true);
    expect(res.new_finding_count).toBe(1);
    expect(posts).toHaveLength(1);
    // the insert body itself carries no score columns — scoring PATCHes after insert
    expect(posts[0].priority_score).toBeUndefined();
    const scoringRead = fetchMock.mock.calls.find((c) => String(c[0]).includes('quality=is.null'));
    expect(scoringRead).toBeDefined();
  });
});

describe('listing order and floor', () => {
  const q = (confidence: number, success: number, executable = true) => ({ confidence, success_odds: success, executable });

  it('priority desc, unscored last, tie-break after priority', () => {
    const rows = [
      { id: 'unscored', status: 'new', priority_score: null, risk_class: 'high' },
      { id: 'low', status: 'new', priority_score: 0.1, quality: q(0.9, 0.9), risk_class: 'high' },
      { id: 'hi', status: 'new', priority_score: 0.9, quality: q(0.9, 0.9), risk_class: 'low' },
      { id: 'tie-med', status: 'new', priority_score: 0.5, quality: q(0.9, 0.9), risk_class: 'medium' },
      { id: 'tie-high', status: 'new', priority_score: 0.5, quality: q(0.9, 0.9), risk_class: 'high' },
    ];
    expect(sortByPriority(rows, comparePendingApprovals).map((r) => r.id)).toEqual(['hi', 'tie-high', 'tie-med', 'low', 'unscored']);
  });

  it('open rows below the floor are left out and counted; include_below_floor keeps them; unscored rows stay', () => {
    const rows = [
      { id: 'a', status: 'new', priority_score: 0.5, quality: q(0.9, 0.5) },
      { id: 'b', status: 'new', priority_score: 0.9, quality: q(0.4, 0.9) },
      { id: 'c', status: 'new', priority_score: 0.7, quality: q(0.9, 0.1) },
      { id: 'd', status: 'new', priority_score: 0.2, quality: q(0.9, 0.0, false) },
      { id: 'e', status: 'activated', priority_score: 0.1, quality: q(0.1, 0.0) },
      { id: 'f', status: 'new', priority_score: null, quality: null },
    ];
    const out = applyDeveloperQualityListing(rows);
    expect(out.rows.map((r) => r.id)).toEqual(['a', 'd', 'e', 'f']);
    expect(out.below_floor_count).toBe(2);
    const all = applyDeveloperQualityListing(rows, { includeBelowFloor: true });
    expect(all.rows.map((r) => r.id)).toEqual(['b', 'c', 'a', 'd', 'e', 'f']);
    expect(all.below_floor_count).toBe(2);
  });

  it('GET /pending-approvals orders by priority, hides below-floor rows and reports below_floor_count', async () => {
    let seenUrl = '';
    route((url) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        seenUrl = url;
        return jsonRes(200, [
          { id: 'h', risk_class: 'high', impact_score: 8, priority_score: 0.2, quality: q(0.7, 0.5), status: 'new' },
          { id: 'm', risk_class: 'medium', impact_score: 6, priority_score: 0.8, quality: q(0.7, 0.5), status: 'new' },
          { id: 'x', risk_class: 'high', impact_score: 9, priority_score: 0.9, quality: q(0.3, 0.5), status: 'new' },
        ]);
      }
      return undefined;
    });
    const res = await request(app).get('/api/v1/dev-autopilot/pending-approvals').set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.recommendations.map((r: any) => r.id)).toEqual(['m', 'h']);
    expect(res.body.below_floor_count).toBe(1);
    expect(res.body.recommendations[0].quality).toBeDefined();
    expect(res.body.recommendations[0].priority_score).toBe(0.8);
    expect(seenUrl).toContain('priority_score,quality');
    expect(seenUrl).toContain('order=priority_score.desc.nullslast');

    const all = await request(app).get('/api/v1/dev-autopilot/pending-approvals?include_below_floor=1').set('Authorization', 'Bearer admin');
    expect(all.body.recommendations.map((r: any) => r.id)).toEqual(['x', 'm', 'h']);

    const count = await request(app).get('/api/v1/dev-autopilot/pending-approvals/count').set('Authorization', 'Bearer admin');
    expect(count.body).toMatchObject({ ok: true, count: 2, below_floor_count: 1 });
  });

  it('developer lineup (queryRecommendationsByRole) orders by priority, filters the floor, pages after', async () => {
    let seenUrl = '';
    route((url) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        seenUrl = url;
        return jsonRes(200, [
          { id: 'p1', status: 'new', impact_score: 5, priority_score: 0.1, quality: q(0.7, 0.5) },
          { id: 'p2', status: 'new', impact_score: 5, priority_score: 0.6, quality: q(0.7, 0.5) },
          { id: 'below', status: 'new', impact_score: 9, priority_score: 0.9, quality: q(0.2, 0.5) },
          { id: 'none', status: 'new', impact_score: 9, priority_score: null, quality: null },
        ]);
      }
      return undefined;
    });
    const r = await queryRecommendationsByRole('developer', null, ['new'], 2, 0);
    expect(r.data!.map((x: any) => x.id)).toEqual(['p2', 'p1']);
    expect(r.count).toBe(3);
    expect(r.below_floor_count).toBe(1);
    const decoded = decodeURIComponent(seenUrl);
    expect(decoded).toContain('priority_score,quality');
    expect(decoded).toContain('order=priority_score.desc.nullslast');
    const page2 = await queryRecommendationsByRole('developer', null, ['new'], 2, 2);
    expect(page2.data!.map((x: any) => x.id)).toEqual(['none']);
    const withBelow = await queryRecommendationsByRole('developer', null, ['new'], 10, 0, { includeBelowFloor: true });
    expect(withBelow.data!.map((x: any) => x.id)[0]).toBe('below');
  });

  it('the community lineup is untouched (no priority columns, DB paging)', async () => {
    let seenUrl = '';
    route((url) => { if (url.includes('/rest/v1/autopilot_recommendations')) { seenUrl = decodeURIComponent(url); return jsonRes(200, []); } return undefined; });
    await queryRecommendationsByRole('community', 'u-1', ['new'], 20, 0);
    expect(seenUrl).not.toContain('priority_score');
    expect(seenUrl).toContain('order=impact_score.desc,created_at.desc');
    expect(seenUrl).toContain('limit=20');
  });
});
