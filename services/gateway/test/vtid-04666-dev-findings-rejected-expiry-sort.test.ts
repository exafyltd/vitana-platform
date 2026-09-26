/**
 * VTID-04666 — developer findings (dev_autopilot / dev_autopilot_impact):
 *   - a fingerprint rejected in the last 30 days is not re-created;
 *   - every new finding carries expires_at, and a re-sighting pushes it forward;
 *   - GET /pending-approvals sorts by an explicit risk rank
 *     (high > medium > low), then impact desc, then created_at desc.
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
jest.mock('../src/services/dev-autopilot-bridge', () => ({
  bridgeFailureToSelfHealing: jest.fn(),
}));
jest.mock('../src/services/dev-autopilot-self-heal-log', () => ({
  writeAutopilotFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/dev-autopilot-safety', () => ({
  dryRunPreflight: jest.fn(),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));
jest.mock('../src/services/dev-autopilot-outcomes', () => ({
  recordOutcome: jest.fn().mockResolvedValue(undefined),
  summarizeSpendToday: jest.fn(),
}));

const SCAN_TOKEN = 'test-scan-token-04666';
process.env.DEV_AUTOPILOT_SCAN_TOKEN = SCAN_TOKEN;
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';

import {
  DEV_RECOMMENDATION_EXPIRY_DAYS,
  REJECTED_FINGERPRINT_BLOCK_DAYS,
  recentlyRejectedFingerprintsPath,
  sortPendingApprovals,
  toFingerprintSet,
} from '../src/services/dev-recommendation-policy';
import { fingerprintSignal, ingestScan, DevAutopilotSignal } from '../src/services/dev-autopilot-synthesis';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/dev-autopilot').default;

const app = express();
app.use(express.json());
app.use('/api/v1/dev-autopilot', router);

const fetchMock = global.fetch as jest.Mock;

function jsonRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Handler = (url: string, opts: any) => any | undefined;
function route(handler: Handler) {
  fetchMock.mockImplementation((url: any, opts: any = {}) => {
    const r = handler(String(url), opts || {});
    return Promise.resolve(r !== undefined ? r : jsonRes(200, []));
  });
}
const method = (opts: any) => (opts && opts.method) || 'GET';

beforeEach(() => {
  fetchMock.mockReset();
  process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
  (jose.jwtVerify as jest.Mock).mockResolvedValue({
    payload: { sub: 'dev-admin-1', email: 'dev@example.com', role: 'authenticated', app_metadata: { exafy_admin: true } },
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('dev-recommendation-policy helpers', () => {
  it('blocks rejected fingerprints for 30 days and expires findings after 30 days', () => {
    expect(REJECTED_FINGERPRINT_BLOCK_DAYS).toBe(30);
    expect(DEV_RECOMMENDATION_EXPIRY_DAYS).toBe(30);
    const now = Date.parse('2026-09-26T00:00:00Z');
    const path = recentlyRejectedFingerprintsPath('dev_autopilot', now);
    expect(path).toContain('source_type=eq.dev_autopilot&');
    expect(path).toContain('status=eq.rejected');
    expect(path).toContain('updated_at=gte.2026-08-27T00:00:00.000Z');
  });

  it('toFingerprintSet tolerates junk', () => {
    expect([...toFingerprintSet([{ signal_fingerprint: 'a' }, { signal_fingerprint: null }, null, {}])]).toEqual(['a']);
    expect(toFingerprintSet(undefined).size).toBe(0);
  });

  it('sortPendingApprovals: high > medium > low (not text order), then impact desc, then created_at desc', () => {
    const rows = [
      { id: 'low', risk_class: 'low', impact_score: 9, created_at: '2026-09-25T00:00:00Z' },
      { id: 'med-old', risk_class: 'medium', impact_score: 6, created_at: '2026-09-01T00:00:00Z' },
      { id: 'high', risk_class: 'high', impact_score: 3, created_at: '2026-09-01T00:00:00Z' },
      { id: 'med-new', risk_class: 'medium', impact_score: 6, created_at: '2026-09-20T00:00:00Z' },
      { id: 'med-hi-impact', risk_class: 'medium', impact_score: 8, created_at: '2026-08-01T00:00:00Z' },
      { id: 'unset', risk_class: null, impact_score: 10, created_at: '2026-09-26T00:00:00Z' },
    ];
    expect(sortPendingApprovals(rows).map((r) => r.id)).toEqual(['high', 'med-hi-impact', 'med-new', 'med-old', 'low', 'unset']);
  });
});

// ---------------------------------------------------------------------------
// ingestScan (dev_autopilot)
// ---------------------------------------------------------------------------

const signal = (over: Partial<DevAutopilotSignal> = {}): DevAutopilotSignal => ({
  type: 'dead_code',
  severity: 'medium',
  file_path: 'services/gateway/src/routes/foo.ts',
  line_number: 42,
  message: 'Unused export `foo`',
  suggested_action: 'Remove export',
  scanner: 'knip',
  ...over,
});

describe('ingestScan — rejected fingerprints and expiry', () => {
  function baseRoutes(extra: Handler, posts: any[], patches: any[]) {
    route((url, opts) => {
      const m = method(opts);
      const hit = extra(url, opts);
      if (hit !== undefined) return hit;
      if (url.includes('/dev_autopilot_runs')) return jsonRes(m === 'POST' ? 201 : 204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && m === 'POST') {
        posts.push(JSON.parse(opts.body));
        return jsonRes(201, {});
      }
      if (url.includes('/autopilot_recommendations') && m === 'PATCH') {
        patches.push(JSON.parse(opts.body));
        return jsonRes(204, {});
      }
      return undefined;
    });
  }

  it('skips a signal whose fingerprint was rejected in the last 30 days', async () => {
    const fp = fingerprintSignal(signal());
    const posts: any[] = [];
    baseRoutes((url, opts) => {
      if (url.includes('status=eq.rejected') && method(opts) === 'GET') return jsonRes(200, [{ signal_fingerprint: fp }]);
      return undefined;
    }, posts, []);

    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });
    expect(result.ok).toBe(true);
    expect(result.new_finding_count).toBe(0);
    expect(result.suppressed_rejected_count).toBe(1);
    expect(posts).toHaveLength(0);
  });

  it('inserts a new finding with expires_at 30 days out', async () => {
    const posts: any[] = [];
    baseRoutes(() => undefined, posts, []);
    const before = Date.now();
    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });
    expect(result.new_finding_count).toBe(1);
    const exp = Date.parse(posts[0].expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + 29.9 * 86400000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 30 * 86400000 + 1000);
  });

  it('a re-sighting of a live finding pushes expires_at forward (never blocked by an older rejection)', async () => {
    const fp = fingerprintSignal(signal());
    const patches: any[] = [];
    baseRoutes((url, opts) => {
      if (url.includes('status=eq.rejected')) return jsonRes(200, [{ signal_fingerprint: fp }]);
      if (url.includes('status=in.(new,snoozed,activated)') && method(opts) === 'GET') {
        return jsonRes(200, [{ id: 'live-1', seen_count: 2, last_seen_at: null, status: 'new' }]);
      }
      return undefined;
    }, [], patches);
    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });
    expect(result.updated_finding_count).toBe(1);
    expect(patches.find((p) => p.seen_count === 3).expires_at).toBeDefined();
  });

  it('a failed rejected-fingerprint lookup blocks nothing (pre-VTID-04666 behaviour)', async () => {
    const posts: any[] = [];
    baseRoutes((url) => (url.includes('status=eq.rejected') ? jsonRes(500, { message: 'boom' }) : undefined), posts, []);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });
    warn.mockRestore();
    expect(result.new_finding_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /impact-ingest (dev_autopilot_impact)
// ---------------------------------------------------------------------------

describe('POST /impact-ingest — rejected fingerprints and expiry', () => {
  const finding = { rule: 'r-04666', severity: 'blocker', file_path: 'src/x.ts', message: 'm-04666' };

  it('does not re-create a finding rejected in the last 30 days', async () => {
    const { createHash } = require('node:crypto');
    const fp = createHash('sha256').update(`${finding.rule}|${finding.file_path}|${finding.message.slice(0, 60)}`).digest('hex').slice(0, 32);
    let posted = 0;
    let rejectedUrl = '';
    route((url, opts) => {
      if (url.includes('status=eq.rejected')) {
        rejectedUrl = url;
        return jsonRes(200, [{ signal_fingerprint: fp }]);
      }
      if (url.includes('/autopilot_recommendations') && method(opts) === 'POST') {
        posted++;
        return jsonRes(201, {});
      }
      return undefined;
    });
    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ findings: [finding] });
    expect(res.status).toBe(200);
    expect(res.body.new_count).toBe(0);
    expect(res.body.suppressed_rejected).toBe(1);
    expect(posted).toBe(0);
    expect(rejectedUrl).toContain('source_type=eq.dev_autopilot_impact');
  });

  it('a new finding carries expires_at; a re-sighting refreshes it', async () => {
    let inserted: any = null;
    route((url, opts) => {
      if (url.includes('/autopilot_recommendations') && method(opts) === 'POST') {
        inserted = JSON.parse(opts.body);
        return jsonRes(201, {});
      }
      return undefined;
    });
    await request(app).post('/api/v1/dev-autopilot/impact-ingest').set('X-DevAutopilot-Scan-Token', SCAN_TOKEN).send({ findings: [finding] });
    expect(typeof inserted.expires_at).toBe('string');

    let patched: any = null;
    route((url, opts) => {
      if (url.includes('status=in.(new,snoozed,activated)')) return jsonRes(200, [{ id: 'live', seen_count: 1 }]);
      if (url.includes('id=eq.live') && method(opts) === 'PATCH') {
        patched = JSON.parse(opts.body);
        return jsonRes(200, {});
      }
      return undefined;
    });
    const res = await request(app).post('/api/v1/dev-autopilot/impact-ingest').set('X-DevAutopilot-Scan-Token', SCAN_TOKEN).send({ findings: [finding] });
    expect(res.body.updated_count).toBe(1);
    expect(typeof patched.expires_at).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// GET /pending-approvals
// ---------------------------------------------------------------------------

describe('GET /pending-approvals — explicit risk order, dev sources only, expiry filter', () => {
  it('returns high first even though PostgREST text order would put it last, and pages after sorting', async () => {
    let seenUrl = '';
    route((url) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        seenUrl = url;
        return jsonRes(200, [
          { id: 'm', risk_class: 'medium', impact_score: 6, created_at: '2026-09-20T00:00:00Z' },
          { id: 'l', risk_class: 'low', impact_score: 3, created_at: '2026-09-21T00:00:00Z' },
          { id: 'h', risk_class: 'high', impact_score: 8, created_at: '2026-09-01T00:00:00Z' },
        ]);
      }
      return undefined;
    });
    const res = await request(app).get('/api/v1/dev-autopilot/pending-approvals').set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.recommendations.map((r: any) => r.id)).toEqual(['h', 'm', 'l']);
    expect(seenUrl).toContain('source_type=in.(dev_autopilot,dev_autopilot_impact)');
    expect(seenUrl).not.toContain('operator_onramp');
    expect(seenUrl).toContain('expires_at.gt.now()');
    expect(seenUrl).not.toContain('risk_class.desc');

    const page2 = await request(app).get('/api/v1/dev-autopilot/pending-approvals?limit=1&offset=1').set('Authorization', 'Bearer admin');
    expect(page2.body.recommendations.map((r: any) => r.id)).toEqual(['m']);
  });
});
