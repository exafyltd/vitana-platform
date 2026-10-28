/**
 * VTID-04666 — roadmap analyzer: stalled VTIDs are approved, non-terminal
 * work that went quiet between stale_days and 365 days ago, newest first.
 *
 * Live noise this pins against: "Unblock VTID-01057 … stalled in voided —
 * no activity for 9765 days" (docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md §2).
 */

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  analyzeRoadmap,
  buildStalledVtidQuery,
  isStalledVtidCandidate,
  NON_STALLABLE_VTID_STATUSES,
  STALLED_VTID_MAX_AGE_DAYS,
} from '../src/services/recommendation-engine/analyzers/roadmap-analyzer';

const DAY = 86400000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  vtid: 'VTID-04000',
  title: 'Some task',
  status: 'in_progress',
  spec_status: 'approved',
  is_terminal: false,
  updated_at: daysAgo(40),
  ...over,
});

describe('isStalledVtidCandidate', () => {
  it('accepts approved, non-terminal, in-progress work between stale_days and 365 days', () => {
    expect(isStalledVtidCandidate(row(), NOW, 30)).toBe(true);
  });

  it('rejects terminal rows', () => {
    expect(isStalledVtidCandidate(row({ is_terminal: true }), NOW, 30)).toBe(false);
  });

  it.each(['voided', 'deleted', 'rejected', 'cancelled', 'allocated', 'completed', 'archived', 'VOIDED'])(
    'rejects status %s',
    (status) => {
      expect(isStalledVtidCandidate(row({ status }), NOW, 30)).toBe(false);
    },
  );

  it('rejects rows whose spec is not approved', () => {
    for (const spec_status of ['draft', 'pending_approval', 'missing', null, undefined]) {
      expect(isStalledVtidCandidate(row({ spec_status }), NOW, 30)).toBe(false);
    }
  });

  it('rejects rows older than 365 days (dead, not stalled)', () => {
    expect(isStalledVtidCandidate(row({ updated_at: daysAgo(STALLED_VTID_MAX_AGE_DAYS + 1) }), NOW, 30)).toBe(false);
    expect(isStalledVtidCandidate(row({ updated_at: daysAgo(9765) }), NOW, 30)).toBe(false);
  });

  it('rejects rows touched more recently than stale_days', () => {
    expect(isStalledVtidCandidate(row({ updated_at: daysAgo(3) }), NOW, 30)).toBe(false);
  });
});

describe('buildStalledVtidQuery', () => {
  const q = buildStalledVtidQuery(NOW, 30);

  it('excludes every non-stallable status, terminal rows, and unapproved specs', () => {
    expect(q).toContain(`status=not.in.(${NON_STALLABLE_VTID_STATUSES.join(',')})`);
    for (const s of ['voided', 'deleted', 'rejected', 'cancelled', 'allocated']) expect(q).toContain(s);
    expect(q).toContain('is_terminal=not.is.true');
    expect(q).toContain('spec_status=eq.approved');
  });

  it('bounds the age on both sides and orders newest-stalled first', () => {
    expect(q).toContain(`updated_at=lt.${daysAgo(30)}`);
    expect(q).toContain(`updated_at=gt.${daysAgo(365)}`);
    expect(q).toContain('order=updated_at.desc');
    expect(q).not.toContain('order=updated_at.asc');
  });
});

describe('analyzeRoadmap — stalled VTIDs end to end over a mocked ledger', () => {
  const fetchMock = global.fetch as jest.Mock;
  let realNow: () => number;

  beforeEach(() => {
    realNow = Date.now;
    Date.now = () => NOW;
    fetchMock.mockReset();
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it('drops noise rows the query let through and returns newest-stalled first', async () => {
    let seenUrl = '';
    fetchMock.mockImplementation((url: string) => {
      seenUrl = String(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [
          row({ vtid: 'VTID-01057', status: 'voided', updated_at: daysAgo(9765) }),
          row({ vtid: 'VTID-03000', updated_at: daysAgo(200) }),
          row({ vtid: 'VTID-03500', is_terminal: true }),
          row({ vtid: 'VTID-04100', updated_at: daysAgo(45) }),
          row({ vtid: 'VTID-04200', spec_status: 'draft' }),
        ],
      });
    });

    const result = await analyzeRoadmap('/nonexistent-base-path', { stale_days: 30 });

    expect(result.ok).toBe(true);
    expect(seenUrl).toContain('/rest/v1/vtid_ledger?');
    expect(seenUrl).toContain('spec_status=eq.approved');
    const refs = result.signals.filter((s) => s.type === 'stalled_vtid').map((s) => s.reference);
    expect(refs).toEqual(['VTID-04100', 'VTID-03000']);
    expect(result.signals.some((s) => /voided|9765/.test(s.message))).toBe(false);
  });
});
