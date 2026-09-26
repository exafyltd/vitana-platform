/**
 * VTID-04670 (P5): dismiss reasons, per-producer acceptance, demotion in the
 * P2 score, the supervisor field and the weekly OASIS summary.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));

import {
  acceptanceLookupFrom,
  acceptanceQueryPath,
  buildDismissRecord,
  buildWeeklySummary,
  computeAcceptanceStats,
  DEMOTION_FACTOR,
  DISMISS_REASON_CODES,
  isDismissReasonCode,
  loadAcceptanceStats,
  NOISE_DEMOTION_FACTOR,
  resetAcceptanceState,
  summarizeAcceptance,
  weeklySummaryTick,
  WEEKLY_SUMMARY_EVERY_MS,
  WEEKLY_SUMMARY_TOPIC,
  type AcceptanceRow,
} from '../src/services/recommendation-quality/acceptance';
import { passesQualityFloor, scoreRecommendation, type PriorityRow } from '../src/services/recommendation-quality/priority';
import { buildScorePatch, loadScoringContext, resetScoringServiceState } from '../src/services/recommendation-quality/scoring-service';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function rows(key: { scanner?: string; rule?: string; source_type?: string }, spec: Record<string, number>, reason?: string): AcceptanceRow[] {
  const out: AcceptanceRow[] = [];
  for (const [status, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) {
      out.push({
        source_type: key.source_type || 'dev_autopilot',
        scanner: key.scanner || null,
        rule: key.rule || null,
        status,
        dismiss_reason: status === 'rejected' ? reason ?? null : null,
        updated_at: new Date(NOW - 86400000).toISOString(),
      });
    }
  }
  return out;
}

describe('VTID-04670 dismiss reasons', () => {
  it('accepts exactly the six codes', () => {
    expect([...DISMISS_REASON_CODES]).toEqual(['not_a_real_problem', 'not_worth_it', 'duplicate', 'already_fixed', 'wrong_fix', 'other']);
    for (const c of DISMISS_REASON_CODES) expect(isDismissReasonCode(c)).toBe(true);
    for (const bad of ['', 'nope', 'NOT_WORTH_IT', null, undefined, 3]) expect(isDismissReasonCode(bad)).toBe(false);
  });

  it('buildDismissRecord trims and caps the note at 300 chars', () => {
    const d = buildDismissRecord('wrong_fix', `  ${'x'.repeat(400)}  `, 'user-1', NOW);
    expect(d.reason_code).toBe('wrong_fix');
    expect(d.note).toHaveLength(300);
    expect(d.by).toBe('user-1');
    expect(d.at).toBe(new Date(NOW).toISOString());
    expect(buildDismissRecord('other', '   ', null, NOW).note).toBeNull();
  });
});

describe('VTID-04670 acceptance stats', () => {
  it('counts per breaker key; auto_archived is not a human decision', () => {
    const stats = computeAcceptanceStats([
      ...rows({ scanner: 'todo-scanner-v1' }, { activated: 2, completed: 1, rejected: 3, auto_archived: 4 }, 'not_worth_it'),
      ...rows({ rule: 'R-7', source_type: 'dev_autopilot_impact' }, { rejected: 1 }, 'duplicate'),
      ...rows({ source_type: 'oasis' }, { rejected: 1 }),
      ...rows({ source_type: 'community' }, { rejected: 5 }),
      ...rows({ source_type: 'operator_onramp' }, { activated: 5 }),
    ]);
    const t = stats.get('todo-scanner-v1')!;
    expect(t).toMatchObject({ activated: 2, completed: 1, rejected: 3, auto_archived: 4, decided: 6, accepted: 3, acceptance_rate: 0.5 });
    expect(t.rejected_by_reason).toEqual({ not_worth_it: 3 });
    expect(stats.get('impact:R-7')!.noise_rejections).toBe(1);
    expect(stats.get('oasis')!.rejected_by_reason).toEqual({ unspecified: 1 });
    expect(stats.has('community')).toBe(false);
    expect(stats.has('operator_onramp')).toBe(false);
  });

  it('demotes a key with ≥ 10 human decisions and < 10 % acceptance; noise dismissals demote harder', () => {
    const stats = computeAcceptanceStats([
      ...rows({ scanner: 'lowvalue' }, { activated: 0, rejected: 10 }, 'not_worth_it'),
      ...rows({ scanner: 'noisy' }, { rejected: 10 }, 'not_a_real_problem'),
      ...rows({ scanner: 'few' }, { rejected: 9 }, 'duplicate'),
      ...rows({ scanner: 'fine' }, { activated: 1, rejected: 9 }, 'not_worth_it'),
    ]);
    expect(stats.get('lowvalue')).toMatchObject({ demoted: true, demotion_factor: DEMOTION_FACTOR });
    expect(stats.get('noisy')).toMatchObject({ demoted: true, demotion_factor: NOISE_DEMOTION_FACTOR });
    expect(stats.get('few')).toMatchObject({ demoted: false, demotion_factor: 1 });
    expect(stats.get('fine')).toMatchObject({ demoted: false, acceptance_rate: 0.1 });
  });

  it('reads the last 90 days of decided developer rows in one query; a failed read demotes nothing', async () => {
    resetAcceptanceState();
    const p = acceptanceQueryPath(new Date(NOW - 90 * 86400000).toISOString());
    expect(p).toContain('user_id=is.null');
    expect(p).toContain('status=in.(activated,completed,rejected,auto_archived)');
    expect(p).toContain('dismiss_reason:quality->dismiss->>reason_code');
    const failed = await loadAcceptanceStats(async () => ({ ok: false }), { nowMs: NOW, useCache: false });
    expect(failed.ok).toBe(false);
    expect(failed.stats.size).toBe(0);
  });
});

describe('VTID-04670 demotion in the P2 score', () => {
  const row: PriorityRow = {
    id: 'r1',
    source_type: 'dev_autopilot',
    risk_class: 'high',
    seen_count: 5,
    last_seen_at: new Date(NOW).toISOString(),
    source_ref: 'x',
    spec_snapshot: { scanner: 'noisy', file_path: 'services/gateway/src/a.ts', event_count: 20 },
  };

  it('a demoted producer falls below the confidence floor; others are unchanged', () => {
    const plain = scoreRecommendation(row, { nowMs: NOW });
    expect(passesQualityFloor(plain.quality, { min_confidence: 0.6, min_success_odds: 0.3 })).toBe(true);
    const stats = computeAcceptanceStats(rows({ scanner: 'noisy' }, { rejected: 12 }, 'duplicate'));
    const demoted = scoreRecommendation(row, { nowMs: NOW, acceptanceFor: acceptanceLookupFrom(stats) });
    expect(demoted.quality.confidence).toBeCloseTo(plain.quality.confidence * NOISE_DEMOTION_FACTOR, 3);
    expect(passesQualityFloor(demoted.quality, { min_confidence: 0.6, min_success_odds: 0.3 })).toBe(false);
    expect(demoted.quality.acceptance).toMatchObject({ decided: 12, accepted: 0, demoted: true });
    expect(demoted.quality.basis.acceptance).toMatch(/demoted/);
    expect(demoted.priority_score).toBeLessThan(plain.priority_score);

    const other = computeAcceptanceStats(rows({ scanner: 'other' }, { rejected: 12 }, 'duplicate'));
    const untouched = scoreRecommendation(row, { nowMs: NOW, acceptanceFor: acceptanceLookupFrom(other) });
    expect(untouched.quality.confidence).toBe(plain.quality.confidence);
    expect(untouched.quality.acceptance).toBeUndefined();
  });

  it('priority.ts stays pure: acceptance is injected, never imported', () => {
    const src = SRC('src/services/recommendation-quality/priority.ts');
    expect(src).not.toMatch(/from '\.\/acceptance'/);
    expect(src).toContain('acceptanceFor');
  });

  it('loadScoringContext wires acceptance; the rescore keeps quality.dismiss', async () => {
    resetScoringServiceState();
    resetAcceptanceState();
    const query = jest.fn(async (p: string) => {
      if (p.includes('status=in.(activated,completed,rejected,auto_archived)')) {
        return { ok: true, data: rows({ scanner: 'noisy' }, { rejected: 12 }, 'not_a_real_problem') };
      }
      return { ok: true, data: [] };
    });
    const ctx = await loadScoringContext({ query: query as any, nowMs: NOW });
    expect(ctx.acceptanceFor!('noisy')).toMatchObject({ demoted: true, demotion_factor: NOISE_DEMOTION_FACTOR });
    const patch = buildScorePatch({ ...row, quality: { dismiss: { reason_code: 'duplicate' } } } as any, ctx);
    expect((patch.quality as any).dismiss).toEqual({ reason_code: 'duplicate' });
  });
});

describe('VTID-04670 supervisor and weekly summary', () => {
  it('summarizeAcceptance lists demoted keys first with top dismiss reasons', () => {
    const s = summarizeAcceptance(computeAcceptanceStats([
      ...rows({ scanner: 'ok' }, { activated: 20, rejected: 2 }, 'wrong_fix'),
      ...rows({ scanner: 'bad' }, { rejected: 8 }, 'not_worth_it'),
      ...rows({ scanner: 'bad' }, { rejected: 3 }, 'duplicate'),
    ]));
    expect(s.demoted).toEqual(['bad']);
    expect(s.items[0]).toMatchObject({ key: 'bad', decided: 11, accepted: 0, rate: 0, demoted: true });
    expect(s.items[0].top_dismiss_reasons).toEqual([{ reason: 'not_worth_it', count: 8 }, { reason: 'duplicate', count: 3 }]);
    expect(s.decided).toBe(33);
  });

  it('the supervisor snapshot carries recommendation_acceptance', () => {
    const src = SRC('src/services/dev-autopilot-supervisor.ts');
    expect(src).toContain('recommendation_acceptance: summarizeAcceptance(acceptance.stats, acceptance.ok)');
    expect(src).toContain('await loadAcceptanceStats(');
  });

  it('buildWeeklySummary counts by source/key and slices the last 7 days', () => {
    const decided = [
      ...rows({ scanner: 'a' }, { activated: 1, rejected: 1 }),
      { source_type: 'oasis', status: 'rejected', updated_at: new Date(NOW - 20 * 86400000).toISOString() },
    ];
    const out = buildWeeklySummary({
      stats: computeAcceptanceStats(decided),
      decidedRows: decided,
      createdRows: [{ source_type: 'dev_autopilot', scanner: 'a' }, { source_type: 'oasis' }, { source_type: 'oasis' }],
      nowMs: NOW,
    });
    expect(out.created_by_source).toEqual({ dev_autopilot: 1, oasis: 2 });
    expect(out.created_by_key).toEqual({ a: 1, oasis: 2 });
    expect(out.decided_by_source).toEqual({ dev_autopilot: { activated: 1, rejected: 1 } });
    expect(out.week).toEqual({ decided: 2, accepted: 1, rate: 0.5 });
    expect(out.window.decided).toBe(3);
  });

  it(`emits ${WEEKLY_SUMMARY_TOPIC} once when the newest summary is ≥ 7 days old, and not again within the week`, async () => {
    resetAcceptanceState();
    const emit = jest.fn().mockResolvedValue({ ok: true });
    let lastSummaryAt: string | null = new Date(NOW - WEEKLY_SUMMARY_EVERY_MS - 1000).toISOString();
    const query = jest.fn(async (p: string) => {
      if (p.startsWith('/rest/v1/oasis_events')) {
        expect(p).toContain(`topic=eq.${WEEKLY_SUMMARY_TOPIC}`);
        return { ok: true, data: lastSummaryAt ? [{ created_at: lastSummaryAt }] : [] };
      }
      if (p.includes('status=in.(')) return { ok: true, data: rows({ scanner: 'bad' }, { rejected: 11 }, 'duplicate') };
      return { ok: true, data: [{ source_type: 'dev_autopilot', scanner: 'bad' }] };
    });
    const r1 = await weeklySummaryTick(NOW, { query: query as any, emit });
    expect(r1).toEqual({ emitted: true, reason: 'due' });
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0][0];
    expect(ev).toMatchObject({ vtid: 'VTID-04670', type: WEEKLY_SUMMARY_TOPIC, source: 'recommendation-quality', status: 'warning' });
    expect(ev.payload.demoted_keys).toEqual(['bad']);

    // Same hour → throttled, no reads.
    query.mockClear();
    expect(await weeklySummaryTick(NOW + 1000, { query: query as any, emit })).toEqual({ emitted: false, reason: 'throttled' });
    expect(query).not.toHaveBeenCalled();

    // Next check, but the newest summary is 1 day old → not due.
    lastSummaryAt = new Date(NOW + 2 * 3600000 - 86400000).toISOString();
    expect(await weeklySummaryTick(NOW + 2 * 3600000, { query: query as any, emit })).toEqual({ emitted: false, reason: 'not_due' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the last-summary read fails', async () => {
    resetAcceptanceState();
    const emit = jest.fn();
    const r = await weeklySummaryTick(NOW, { query: (async () => ({ ok: false })) as any, emit });
    expect(r.emitted).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('the event type is registered and the tick runs on the executor loop', () => {
    expect(SRC('src/types/cicd.ts')).toContain(`'${WEEKLY_SUMMARY_TOPIC}' // VTID-04670`);
    expect(SRC('src/services/dev-autopilot-execute.ts')).toMatch(/weeklySummaryTick\(\)\.catch/);
  });
});

// ---------------------------------------------------------------------------
// The reject route
// ---------------------------------------------------------------------------

describe('VTID-04670 POST /recommendations/:id/reject stores the reason', () => {
  const REC_ID = '11111111-1111-4111-8111-111111111111';
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let calls: Array<{ url: string; init: any }>;
  let row: Record<string, unknown> | null;
  const originalFetch = global.fetch;

  function mount() {
    jest.resetModules();
    jest.doMock('../src/services/recommendation-engine', () => ({
      generateRecommendations: jest.fn(),
      generatePersonalRecommendations: jest.fn(),
      regenerateCommunityRecommendations: jest.fn().mockResolvedValue({ ok: true }),
      SourceType: {},
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/autopilot-recommendations').default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.identity = { user_id: USER, exafy_admin: true }; next(); });
    app.use('/api/v1/autopilot/recommendations', router);
    return app;
  }

  beforeEach(() => {
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
    calls = [];
    row = { id: REC_ID, user_id: null, source_type: 'dev_autopilot', quality: { confidence: 0.8, review: { verdict: 'keep' } } };
    global.fetch = jest.fn(async (url: any, init?: any) => {
      const u = String(url);
      calls.push({ url: u, init });
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (u.includes('/rpc/reject_autopilot_recommendation')) return json({ ok: true, recommendation_id: REC_ID, status: 'rejected' });
      if (init?.method === 'PATCH') return { ok: true, status: 204, json: async () => null, text: async () => '' };
      if (u.includes('/rest/v1/autopilot_recommendations?id=eq.')) return json(row ? [row] : []);
      return json([]);
    }) as any;
  });
  afterAll(() => { global.fetch = originalFetch; });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const supertest = require('supertest');

  it('unknown reason_code → 400 and nothing is written', async () => {
    const res = await supertest(mount()).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`).send({ reason_code: 'meh' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason_code/);
    expect(calls.filter((c) => c.url.includes('supabase.test'))).toHaveLength(0);
  });

  it('developer row: RPC first, then quality.dismiss is merged in (review kept)', async () => {
    const res = await supertest(mount()).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`)
      .send({ reason: 'duplicate', reason_code: 'duplicate', note: 'same as #12' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', reason_code: 'duplicate', dismiss_recorded: true });
    const sb = calls.filter((c) => c.url.includes('supabase.test'));
    expect(sb[0].url).toContain('/rpc/reject_autopilot_recommendation');
    expect(JSON.parse(sb[0].init.body)).toEqual({ p_recommendation_id: REC_ID, p_reason: 'duplicate' });
    const patch = sb.find((c) => c.init?.method === 'PATCH')!;
    expect(patch.url).toContain(`id=eq.${REC_ID}&user_id=is.null`);
    const body = JSON.parse(patch.init.body);
    expect(body.quality.review).toEqual({ verdict: 'keep' });
    expect(body.quality.confidence).toBe(0.8);
    expect(body.quality.dismiss).toMatchObject({ reason_code: 'duplicate', note: 'same as #12', by: USER });
  });

  it('community row: the reason is not written (community behaviour unchanged)', async () => {
    row = { id: REC_ID, user_id: USER, source_type: 'community', quality: null };
    const res = await supertest(mount()).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`).send({ reason_code: 'not_worth_it' });
    expect(res.status).toBe(200);
    expect(res.body.dismiss_recorded).toBe(false);
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('no reason code → no extra reads or writes (legacy callers unchanged)', async () => {
    const res = await supertest(mount()).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`).send({ reason: 'not relevant' });
    expect(res.status).toBe(200);
    expect(res.body.reason_code).toBeUndefined();
    expect(calls.filter((c) => c.url.includes('supabase.test'))).toHaveLength(1);
  });

  it('a failed dismiss write does not fail the reject', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/rpc/')) return { ok: true, status: 200, json: async () => ({ ok: true, status: 'rejected' }), text: async () => '' };
      if (init?.method === 'PATCH') return { ok: false, status: 500, json: async () => ({}), text: async () => 'x' };
      return { ok: true, status: 200, json: async () => [row], text: async () => '' };
    });
    const res = await supertest(mount()).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`).send({ reason_code: 'other' });
    expect(res.status).toBe(200);
    expect(res.body.dismiss_recorded).toBe(false);
  });
});
