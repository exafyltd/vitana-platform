/**
 * Tests for the supervisor summary aggregation + route shape
 * (BOOTSTRAP-SUPERVISOR-SUMMARY).
 *
 * Strategy: build a tiny query-builder mock that records the `.eq('topic', x)`
 * / `.in('topic', [...])` filters and resolves to a canned result keyed by
 * which program data source is being read. This lets one mocked Supabase
 * client serve all six sections with distinct data, exercising the per-source
 * aggregation (latest-per-target, window counts, latest lifecycle event) and
 * the final payload shape — without any network or real DB.
 */

import express from 'express';
import request from 'supertest';

const SERVICE_TOKEN = 'test-service-token';

// ---- Canned source data, set per-test --------------------------------------
interface Canned {
  // oasis_events by topic
  dataset?: any[];
  shadowCount?: number;
  finetune?: any[];
  canary?: any[];
  autoPromote?: any[];
  // vtid_ledger count
  backlogCount?: number;
  // force an error on a given source
  errorOn?: 'dataset' | 'shadow' | 'finetune' | 'canary' | 'auto_promote' | 'backlog';
}

let canned: Canned = {};

/**
 * A thenable query builder. Tracks the table + topic filters applied, then
 * resolves to { data, error, count } appropriate to the source. `head:true`
 * count queries resolve a count; data queries resolve rows.
 */
function makeBuilder(table: string) {
  const state: { topics: string[]; head: boolean } = { topics: [], head: false };

  function resolve(): { data: any; error: any; count: number | null } {
    // Determine the logical source from table + topic filters.
    if (table === 'vtid_ledger') {
      if (canned.errorOn === 'backlog') return { data: null, error: { message: 'boom-backlog' }, count: null };
      return { data: null, error: null, count: canned.backlogCount ?? 0 };
    }
    const topics = state.topics;
    const has = (t: string) => topics.includes(t);

    if (has('dataset.extraction.completed')) {
      if (canned.errorOn === 'dataset') return { data: null, error: { message: 'boom-dataset' }, count: null };
      return { data: canned.dataset ?? [], error: null, count: null };
    }
    if (has('eval.shadow.compared')) {
      if (canned.errorOn === 'shadow') return { data: null, error: { message: 'boom-shadow' }, count: null };
      return { data: null, error: null, count: canned.shadowCount ?? 0 };
    }
    if (has('finetune.training.completed')) {
      if (canned.errorOn === 'finetune') return { data: null, error: { message: 'boom-finetune' }, count: null };
      return { data: canned.finetune ?? [], error: null, count: null };
    }
    if (has('production.canary.requested')) {
      if (canned.errorOn === 'canary') return { data: null, error: { message: 'boom-canary' }, count: null };
      return { data: canned.canary ?? [], error: null, count: null };
    }
    if (has('auto_promote.proposed')) {
      if (canned.errorOn === 'auto_promote') return { data: null, error: { message: 'boom-ap' }, count: null };
      return { data: canned.autoPromote ?? [], error: null, count: null };
    }
    return { data: [], error: null, count: 0 };
  }

  const builder: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) state.head = true;
      return builder;
    },
    eq: (col: string, val: any) => {
      if (col === 'topic') state.topics.push(val);
      return builder;
    },
    in: (col: string, vals: any[]) => {
      if (col === 'topic') state.topics.push(...vals);
      return builder;
    },
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    // thenable so `await query` works
    then: (onFulfilled: (v: any) => void) => Promise.resolve(resolve()).then(onFulfilled),
  };
  return builder;
}

const mockSupabase = {
  from: jest.fn((table: string) => makeBuilder(table)),
};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

import { supervisorSummaryRouter, buildSummary } from '../../src/routes/supervisor-summary';

const app = express();
app.use(express.json());
app.use('/api/v1/supervisor', supervisorSummaryRouter);

function authed() {
  return request(app)
    .get('/api/v1/supervisor/summary')
    .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
}

beforeAll(() => {
  process.env.GATEWAY_SERVICE_TOKEN = SERVICE_TOKEN;
});

beforeEach(() => {
  jest.clearAllMocks();
  canned = {};
});

describe('GET /api/v1/supervisor/summary — auth', () => {
  it('401 when no bearer token', async () => {
    const res = await request(app).get('/api/v1/supervisor/summary');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('401 when token is wrong', async () => {
    const res = await request(app)
      .get('/api/v1/supervisor/summary')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/v1/supervisor/summary — shape', () => {
  it('returns ok:true with all six sections present', async () => {
    const res = await authed();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const d = res.body.data;
    expect(d).toHaveProperty('generated_at');
    expect(d).toHaveProperty('window_hours', 24);
    expect(d).toHaveProperty('since_iso');
    for (const section of ['dataset', 'shadow', 'finetune', 'canary', 'auto_promote', 'backlog']) {
      expect(d).toHaveProperty(section);
      expect(d[section]).toHaveProperty('available', true);
    }
  });

  it('clamps window_hours into [1, 168]', async () => {
    const big = await request(app)
      .get('/api/v1/supervisor/summary?window_hours=9999')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(big.body.data.window_hours).toBe(168);

    const small = await request(app)
      .get('/api/v1/supervisor/summary?window_hours=0')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(small.body.data.window_hours).toBe(1);
  });
});

describe('buildSummary — aggregation', () => {
  it('dataset: keeps latest event per target and sums rows', async () => {
    canned.dataset = [
      // most recent first (route orders desc; mock returns as-is)
      { created_at: '2026-06-02T10:00:00Z', metadata: { target: 'voice-tool-routing', rows_after_dedup: 1200 } },
      { created_at: '2026-06-01T10:00:00Z', metadata: { target: 'voice-tool-routing', rows_after_dedup: 800 } },
      { created_at: '2026-06-02T09:00:00Z', metadata: { target: 'intent-kind', rows: 300 } },
    ];
    const summary = await buildSummary(mockSupabase as any, 24);
    const ds: any = summary.data.dataset;
    expect(ds.event_count).toBe(3);
    expect(ds.latest_per_target).toHaveLength(2);
    // latest voice-tool-routing row count (1200, not 800) + intent-kind (300 via .rows fallback)
    expect(ds.total_rows_latest).toBe(1500);
    const vtr = ds.latest_per_target.find((t: any) => t.target === 'voice-tool-routing');
    expect(vtr.rows).toBe(1200);
  });

  it('shadow: surfaces window count and insufficient_data flag', async () => {
    canned.shadowCount = 0;
    let summary = await buildSummary(mockSupabase as any, 24);
    expect((summary.data.shadow as any).compared_events_in_window).toBe(0);
    expect((summary.data.shadow as any).insufficient_data).toBe(true);

    canned.shadowCount = 42;
    summary = await buildSummary(mockSupabase as any, 24);
    expect((summary.data.shadow as any).compared_events_in_window).toBe(42);
    expect((summary.data.shadow as any).insufficient_data).toBe(false);
  });

  it('finetune: latest per target + overall latest status', async () => {
    canned.finetune = [
      { created_at: '2026-06-02T08:00:00Z', metadata: { target: 'voice-tool-router', status: 'SUCCEEDED', job_id: 'job-9' } },
      { created_at: '2026-06-01T08:00:00Z', metadata: { target: 'voice-tool-router', status: 'FAILED', job_id: 'job-8' } },
    ];
    const summary = await buildSummary(mockSupabase as any, 24);
    const ft: any = summary.data.finetune;
    expect(ft.latest_per_target).toHaveLength(1);
    expect(ft.latest_per_target[0].status).toBe('SUCCEEDED');
    expect(ft.latest_per_target[0].job_id).toBe('job-9');
    expect(ft.latest.status).toBe('SUCCEEDED');
  });

  it('finetune: empty when no runs', async () => {
    canned.finetune = [];
    const summary = await buildSummary(mockSupabase as any, 24);
    expect((summary.data.finetune as any).latest).toBeNull();
    expect((summary.data.finetune as any).latest_per_target).toHaveLength(0);
  });

  it('canary: extracts latest lifecycle phase from topic', async () => {
    canned.canary = [
      { topic: 'production.canary.promoted', created_at: '2026-06-02T07:00:00Z', metadata: { revision: 'r-123' } },
    ];
    const summary = await buildSummary(mockSupabase as any, 24);
    const c: any = summary.data.canary;
    expect(c.latest_event).toBe('production.canary.promoted');
    expect(c.latest_phase).toBe('promoted');
    expect(c.metadata.revision).toBe('r-123');
  });

  it('canary: null when no lifecycle events', async () => {
    canned.canary = [];
    const summary = await buildSummary(mockSupabase as any, 24);
    expect((summary.data.canary as any).latest_event).toBeNull();
    expect((summary.data.canary as any).latest_phase).toBeNull();
  });

  it('auto_promote: counts proposed/rejected in window and surfaces latest decision', async () => {
    canned.autoPromote = [
      { topic: 'auto_promote.rejected', created_at: '2026-06-02T06:00:00Z', metadata: { reason: 'agreement_low' } },
      { topic: 'auto_promote.proposed', created_at: '2026-06-01T06:00:00Z', metadata: { from: 'off', to: 'shadow' } },
      { topic: 'auto_promote.proposed', created_at: '2026-05-31T06:00:00Z', metadata: {} },
    ];
    const summary = await buildSummary(mockSupabase as any, 168);
    const ap: any = summary.data.auto_promote;
    expect(ap.proposed_in_window).toBe(2);
    expect(ap.rejected_in_window).toBe(1);
    expect(ap.latest_decision.decision).toBe('rejected');
    expect(ap.latest_decision.metadata.reason).toBe('agreement_low');
  });

  it('backlog: reports pending non-terminal task count', async () => {
    canned.backlogCount = 7;
    const summary = await buildSummary(mockSupabase as any, 24);
    expect((summary.data.backlog as any).pending_tasks).toBe(7);
  });

  it('per-source error is isolated to that section (available:false), others still ok', async () => {
    canned.errorOn = 'dataset';
    canned.shadowCount = 5;
    const summary = await buildSummary(mockSupabase as any, 24);
    expect((summary.data.dataset as any).available).toBe(false);
    expect((summary.data.dataset as any).error).toBe('boom-dataset');
    // sibling section unaffected
    expect((summary.data.shadow as any).available).toBe(true);
    expect((summary.data.shadow as any).compared_events_in_window).toBe(5);
    // overall envelope still ok
    expect(summary.ok).toBe(true);
  });
});
