/**
 * VTID-04669 (P3): one bounded planner-stage quality review before a
 * developer recommendation card is shown.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import {
  parseReviewVerdict,
  decideReviewOutcome,
  selectReviewCandidates,
  qualityReviewTick,
  reviewRecommendation,
  resetQualityReviewState,
  isQualityReviewEnabled,
  resolveReviewDailyCap,
  reviewRouterTools,
  buildReviewPrompt,
  REVIEW_MAX_ATTEMPTS,
  REVIEW_EVERY_MS,
  REVIEW_BATCH,
  REVIEW_STAGE,
  REVIEW_SERVICE,
} from '../src/services/recommendation-quality/quality-review';
import { applyDeveloperQualityListing } from '../src/services/recommendation-quality/listing';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const passing = { version: 1, value: 0.7, confidence: 0.8, success_odds: 0.5, executable: true };
const below = { version: 1, value: 0.7, confidence: 0.3, success_odds: 0.5, executable: true };

const rec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'new',
  source_type: 'dev_autopilot',
  title: `Fix ${id}`,
  summary: 'Route lacks auth',
  spec_snapshot: { scanner: 'route-auth-scanner-v1', file_path: 'services/gateway/src/routes/x.ts' },
  quality: { ...passing },
  ...over,
});

const KEEP = JSON.stringify({
  verdict: 'keep',
  problem: 'GET /x has no auth middleware',
  evidence: ['router.get("/x", handler) in routes/x.ts:12'],
  files: [{ path: 'services/gateway/src/routes/x.ts', risk: 'low churn' }],
  acceptance: ['401 without a token'],
  why_now: 'member data exposed',
});

function loopReturning(text: string | null, extra: Record<string, unknown> = {}) {
  return jest.fn(async () => ({
    ok: text !== null,
    text: text ?? undefined,
    error: text === null ? 'both providers failed' : undefined,
    provider: 'bedrock',
    model: 'eu.anthropic.claude-sonnet-4-6',
    fallbackUsed: false,
    usage: { inputTokens: 1200, outputTokens: 300 },
    turns: 2,
    toolCalls: 1,
    toolNames: ['dev_index_query'],
    history: [],
    steps: [],
    budgetExhausted: false,
    stalled: false,
    ...extra,
  })) as any;
}

/** Fake PostgREST for the tick: records patches, answers the cap and candidate reads. */
function fakeDb(opts: { reviewedToday?: number; candidates?: any[] } = {}) {
  const patches: Array<{ path: string; body: any }> = [];
  const paths: string[] = [];
  const query = async (p: string) => {
    paths.push(p);
    if (p.includes('quality->review->>reviewed_at')) return { ok: true, data: Array.from({ length: opts.reviewedToday || 0 }, (_, i) => ({ id: `t${i}` })) };
    return { ok: true, data: opts.candidates || [] };
  };
  const patch = async (path: string, body: any) => { patches.push({ path, body }); return { ok: true }; };
  return { patches, paths, query: query as any, patch: patch as any };
}

beforeEach(() => resetQualityReviewState());

describe('parseReviewVerdict (tolerant)', () => {
  it('parses strict JSON, fenced JSON and JSON inside prose', () => {
    expect(parseReviewVerdict(KEEP)!.verdict).toBe('keep');
    expect(parseReviewVerdict('```json\n' + KEEP + '\n```')!.files).toEqual([{ path: 'services/gateway/src/routes/x.ts', risk: 'low churn' }]);
    const v = parseReviewVerdict(`Here is my review: ${KEEP} — done.`)!;
    expect(v.evidence).toHaveLength(1);
    expect(v.acceptance).toEqual(['401 without a token']);
  });

  it('normalises loose shapes (string files, string evidence, uppercase verdict) and supplies a drop reason', () => {
    const v = parseReviewVerdict('{"verdict":"DROP","files":["a/b.ts"],"evidence":"one line"}')!;
    expect(v.verdict).toBe('drop');
    expect(v.files).toEqual([{ path: 'a/b.ts', risk: 'unknown' }]);
    expect(v.evidence).toEqual(['one line']);
    expect(v.drop_reason).toBeTruthy();
  });

  it('returns null when there is no usable verdict', () => {
    expect(parseReviewVerdict(null)).toBeNull();
    expect(parseReviewVerdict('I think it is fine.')).toBeNull();
    expect(parseReviewVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseReviewVerdict('{"verdict":"keep", broken')).toBeNull();
  });
});

describe('decideReviewOutcome', () => {
  it('keep stays keep; drop archives; an executable keep without file or evidence archives', () => {
    const keep = parseReviewVerdict(KEEP)!;
    expect(decideReviewOutcome({ source_type: 'dev_autopilot' }, keep)).toEqual({ action: 'keep' });
    expect(decideReviewOutcome({ source_type: 'dev_autopilot' }, { ...keep, verdict: 'drop', drop_reason: 'noise' })).toEqual({ action: 'archive', drop_reason: 'noise' });
    expect(decideReviewOutcome({ source_type: 'dev_autopilot' }, { ...keep, files: [] }).action).toBe('archive');
    expect(decideReviewOutcome({ source_type: 'dev_autopilot_impact' }, { ...keep, evidence: [] }).action).toBe('archive');
    // a non-executable card (a developer does it by hand) may be kept without a file
    expect(decideReviewOutcome({ source_type: 'oasis' }, { ...keep, files: [] })).toEqual({ action: 'keep' });
  });
});

describe('selectReviewCandidates', () => {
  it('only scored, above-floor, unreviewed rows with attempts left — never a model call below the floor', () => {
    const rows = [
      rec('a'),
      rec('below', { quality: below }),
      rec('unscored', { quality: null }),
      rec('done', { quality: { ...passing, review: { verdict: 'keep' } } }),
      rec('spent', { quality: { ...passing, review_attempts: REVIEW_MAX_ATTEMPTS } }),
      rec('b', { quality: { ...passing, review_attempts: 1 } }),
    ];
    expect(selectReviewCandidates(rows as any, 10).map((r) => r.id)).toEqual(['a', 'b']);
    expect(selectReviewCandidates(rows as any, 1).map((r) => r.id)).toEqual(['a']);
  });
});

describe('reviewRecommendation', () => {
  it('runs the planner stage with only dev_index_query / dev_get_risk, bounded, with no provider override', async () => {
    const runLoop = loopReturning(KEEP);
    const r = await reviewRecommendation(rec('a') as any, { runLoop, loadIndex: async () => ({ sha: 'abc' } as any) });
    expect(r.verdict!.verdict).toBe('keep');
    const opts = runLoop.mock.calls[0][0];
    expect(opts.stage).toBe(REVIEW_STAGE);
    expect(opts.stage).toBe('planner');
    expect(opts.service).toBe(REVIEW_SERVICE);
    expect(opts.maxTurns).toBe(4);
    expect(opts.maxToolCalls).toBe(6);
    expect(opts.deadlineMs).toBe(90_000);
    expect(opts.providerOverride).toBeUndefined();
    expect(opts.modelOverride).toBeUndefined();
    expect(opts.tools.map((t: any) => t.name).sort()).toEqual(['dev_get_risk', 'dev_index_query']);
    expect(reviewRouterTools().map((t) => t.name)).not.toContain('dev_graph_path');
    expect(opts.prompt).toContain('Fix a');
  });

  it('no index → one tool-less call; the loop failing → no verdict, never a throw', async () => {
    const runLoop = loopReturning(null);
    const r = await reviewRecommendation(rec('a') as any, { runLoop, loadIndex: async () => { throw new Error('s3 down'); } });
    expect(r.verdict).toBeNull();
    expect(runLoop.mock.calls[0][0].tools).toEqual([]);
    expect(runLoop.mock.calls[0][0].maxTurns).toBe(1);
  });

  it('the prompt is written as intent in English and asks for JSON only', () => {
    expect(buildReviewPrompt(rec('a') as any)).toContain('answer with the JSON object only');
  });
});

describe('qualityReviewTick', () => {
  it('keep → stores quality.review and emits autopilot.recommendation.quality_reviewed', async () => {
    const db = fakeDb({ candidates: [rec('a')] });
    const emit = jest.fn(async () => ({ ok: true })) as any;
    const r = await qualityReviewTick(NOW, { ...db, emit, runLoop: loopReturning(KEEP), loadIndex: async () => null });
    expect(r).toMatchObject({ ran: true, reviewed: 1, kept: 1, archived: 0 });
    expect(db.patches).toHaveLength(1);
    expect(db.patches[0].path).toBe('/rest/v1/autopilot_recommendations?id=eq.a&status=eq.new');
    expect(db.patches[0].body.status).toBeUndefined();
    expect(db.patches[0].body.quality.review).toMatchObject({ verdict: 'keep', provider: 'bedrock', input_tokens: 1200, output_tokens: 300 });
    expect(db.patches[0].body.quality.confidence).toBe(0.8); // P2 components kept
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: 'autopilot.recommendation.quality_reviewed',
      vtid: 'VTID-04669',
      payload: { verdict: 'keep', recommendation_id: 'a', provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6', input_tokens: 1200, output_tokens: 300 },
    });
  });

  it('drop → status auto_archived (never rejected) with the drop reason', async () => {
    const db = fakeDb({ candidates: [rec('a')] });
    const emit = jest.fn(async () => ({ ok: true })) as any;
    const r = await qualityReviewTick(NOW, { ...db, emit, runLoop: loopReturning('{"verdict":"drop","drop_reason":"TODO is a comment, not a defect"}'), loadIndex: async () => null });
    expect(r.archived).toBe(1);
    expect(db.patches[0].body.status).toBe('auto_archived');
    expect(db.patches[0].body.status).not.toBe('rejected');
    expect(db.patches[0].body.quality.review).toMatchObject({ verdict: 'drop', drop_reason: 'TODO is a comment, not a defect' });
    expect(emit.mock.calls[0][0].payload.verdict).toBe('drop');
  });

  it('an executable keep with no concrete file is archived', async () => {
    const db = fakeDb({ candidates: [rec('a')] });
    const noFile = JSON.stringify({ verdict: 'keep', problem: 'p', evidence: ['e'], files: [], acceptance: [], why_now: '' });
    await qualityReviewTick(NOW, { ...db, emit: jest.fn(async () => ({ ok: true })) as any, runLoop: loopReturning(noFile), loadIndex: async () => null });
    expect(db.patches[0].body.status).toBe('auto_archived');
    expect(db.patches[0].body.quality.review.drop_reason).toContain('no concrete file or evidence');
  });

  it('unparseable → no verdict, attempts recorded, no event; retried next tick, stops after 2 attempts', async () => {
    const db = fakeDb({ candidates: [rec('a')] });
    const emit = jest.fn(async () => ({ ok: true })) as any;
    const r = await qualityReviewTick(NOW, { ...db, emit, runLoop: loopReturning('not json'), loadIndex: async () => null });
    expect(r.no_verdict).toBe(1);
    expect(db.patches[0].body.quality.review_attempts).toBe(1);
    expect(db.patches[0].body.quality.review).toBeUndefined();
    expect(db.patches[0].body.status).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    const exhausted = fakeDb({ candidates: [rec('a', { quality: { ...passing, review_attempts: REVIEW_MAX_ATTEMPTS } })] });
    const runLoop = loopReturning(KEEP);
    await qualityReviewTick(NOW + REVIEW_EVERY_MS, { ...exhausted, emit, runLoop, loadIndex: async () => null });
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('no model call for rows below the floor', async () => {
    const db = fakeDb({ candidates: [rec('b', { quality: below })] });
    const runLoop = loopReturning(KEEP);
    const r = await qualityReviewTick(NOW, { ...db, runLoop, loadIndex: async () => null });
    expect(runLoop).not.toHaveBeenCalled();
    expect(r.reviewed).toBe(0);
    expect(db.patches).toHaveLength(0);
  });

  it('batch ≤ 5 per tick, every 15 min', async () => {
    const db = fakeDb({ candidates: Array.from({ length: 8 }, (_, i) => rec(`r${i}`)) });
    const runLoop = loopReturning(KEEP);
    const r = await qualityReviewTick(NOW, { ...db, runLoop, emit: jest.fn(async () => ({ ok: true })) as any, loadIndex: async () => null });
    expect(r.reviewed).toBe(REVIEW_BATCH);
    expect(runLoop).toHaveBeenCalledTimes(5);
    const again = await qualityReviewTick(NOW + 60_000, { ...db, runLoop, loadIndex: async () => null });
    expect(again).toMatchObject({ ran: false, reason: 'throttled' });
    expect(db.paths.some((p) => p.includes('quality->review=is.null') && p.includes('order=priority_score.desc'))).toBe(true);
  });

  it('daily cap: counted from quality.review.reviewed_at today; stops at the cap; cap bounds the batch', async () => {
    const full = fakeDb({ reviewedToday: 40, candidates: [rec('a')] });
    const runLoop = loopReturning(KEEP);
    const r = await qualityReviewTick(NOW, { ...full, runLoop, loadIndex: async () => null });
    expect(r).toMatchObject({ ran: false, reason: 'daily_cap' });
    expect(runLoop).not.toHaveBeenCalled();
    expect(full.paths[0]).toContain('quality->review->>reviewed_at=gte.2026-09-26T00%3A00%3A00.000Z');

    resetQualityReviewState();
    const two = fakeDb({ reviewedToday: 38, candidates: Array.from({ length: 5 }, (_, i) => rec(`r${i}`)) });
    const r2 = await qualityReviewTick(NOW, { ...two, runLoop, emit: jest.fn(async () => ({ ok: true })) as any, loadIndex: async () => null });
    expect(r2.reviewed).toBe(2);

    resetQualityReviewState();
    const custom = fakeDb({ reviewedToday: 3, candidates: [rec('a')] });
    const r3 = await qualityReviewTick(NOW, { ...custom, runLoop, env: { AUTOPILOT_QUALITY_REVIEW_DAILY_CAP: '3' }, loadIndex: async () => null });
    expect(r3.reason).toBe('daily_cap');
    expect(resolveReviewDailyCap({})).toBe(40);
    expect(resolveReviewDailyCap({ AUTOPILOT_QUALITY_REVIEW_DAILY_CAP: 'x' })).toBe(40);
  });

  it('kill switch: exact "false" disables (no reads, no calls); anything else leaves it on', async () => {
    const db = fakeDb({ candidates: [rec('a')] });
    const runLoop = loopReturning(KEEP);
    const r = await qualityReviewTick(NOW, { ...db, runLoop, env: { AUTOPILOT_QUALITY_REVIEW_ENABLED: 'false' } });
    expect(r).toMatchObject({ ran: false, reason: 'disabled' });
    expect(db.paths).toHaveLength(0);
    expect(runLoop).not.toHaveBeenCalled();
    expect(isQualityReviewEnabled({})).toBe(true);
    expect(isQualityReviewEnabled({ AUTOPILOT_QUALITY_REVIEW_ENABLED: 'FALSE' })).toBe(true);
    expect(isQualityReviewEnabled({ AUTOPILOT_QUALITY_REVIEW_ENABLED: 'false' })).toBe(false);
  });
});

describe('listing: only reviewed-keep rows while the review is on', () => {
  const rows = [
    { id: 'kept', status: 'new', priority_score: 0.5, quality: { ...passing, review: { verdict: 'keep', problem: 'p' } } },
    { id: 'waiting', status: 'new', priority_score: 0.9, quality: { ...passing } },
    { id: 'unscored', status: 'new', priority_score: null, quality: null },
    { id: 'below', status: 'new', priority_score: 0.8, quality: { ...below } },
    { id: 'activated', status: 'activated', priority_score: 0.1, quality: null },
  ];

  it('review on: unreviewed and unscored open rows are counted in awaiting_review_count, not shown', () => {
    const out = applyDeveloperQualityListing(rows, { reviewEnabled: true });
    expect(out.rows.map((r) => r.id)).toEqual(['kept', 'activated']);
    expect(out.awaiting_review_count).toBe(2);
    expect(out.below_floor_count).toBe(1);
    expect((out.rows[0] as any).quality.review.problem).toBe('p');
  });

  it('review off: P2 behaviour (floor only)', () => {
    const out = applyDeveloperQualityListing(rows, { reviewEnabled: false });
    expect(out.rows.map((r) => r.id)).toEqual(['waiting', 'kept', 'activated', 'unscored']);
    expect(out.awaiting_review_count).toBe(0);
  });

  it('the developer lineup (queryRecommendationsByRole) shows reviewed-keep rows only and reports awaiting_review_count', async () => {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
    const prev = process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED;
    delete process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { queryRecommendationsByRole } = require('../src/routes/autopilot-recommendations');
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [
        { id: 'kept', status: 'new', priority_score: 0.4, quality: { ...passing, review: { verdict: 'keep', problem: 'p', files: [{ path: 'a/b.ts', risk: 'low' }] } } },
        { id: 'waiting', status: 'new', priority_score: 0.9, quality: { ...passing } },
        { id: 'unscored', status: 'new', priority_score: null, quality: null },
      ],
      text: async () => '',
    }));
    const r = await queryRecommendationsByRole('developer', null, ['new'], 20, 0);
    expect(r.data.map((x: any) => x.id)).toEqual(['kept']);
    expect(r.data[0].quality.review.files[0].path).toBe('a/b.ts');
    expect(r.awaiting_review_count).toBe(2);
    expect(r.count).toBe(1);
    if (prev !== undefined) process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED = prev;
  });

  it('defaults to the kill switch', () => {
    const prev = process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED;
    delete process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED;
    expect(applyDeveloperQualityListing(rows).awaiting_review_count).toBe(2);
    process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED = 'false';
    expect(applyDeveloperQualityListing(rows).awaiting_review_count).toBe(0);
    if (prev === undefined) delete process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED; else process.env.AUTOPILOT_QUALITY_REVIEW_ENABLED = prev;
  });
});
