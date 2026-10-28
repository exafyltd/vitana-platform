/**
 * VTID-04666 — operator_onramp rows are not recommendations; the SQL side
 * (insert dedupe, listing RPCs, cleanup) and the one-shot data fix are pinned
 * by contract, since they cannot run against a database in CI.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/notification-service', () => ({ notifyUserAsync: jest.fn() }));
jest.mock('../src/services/recommendation-engine', () => ({
  generateRecommendations: jest.fn(),
  generatePersonalRecommendations: jest.fn(),
  regenerateCommunityRecommendations: jest.fn(),
  SourceType: {},
}));
jest.mock('../src/services/wave-defaults', () => ({ DEFAULT_WAVE_CONFIG: [], buildTemplateToWaveMap: () => new Map() }));

import { queryRecommendationsByRole } from '../src/routes/autopilot-recommendations';

const REPO = path.resolve(__dirname, '../../..');
const MIGRATION = path.join(REPO, 'supabase/migrations/20260926140000_vtid_04666_recommendation_noise.sql');
const FIXUP = path.join(REPO, 'supabase/migrations/data-fixups/20260926140100_vtid_04666_reject_noise.sql');

describe('queryRecommendationsByRole — developer lineup excludes operator_onramp', () => {
  const fetchMock = global.fetch as jest.Mock;
  let seen = '';
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      seen = decodeURIComponent(String(url));
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => '0-0/0' }, json: async () => [], text: async () => '' });
    });
  });

  it.each(['developer', 'admin', 'infra'])('%s: user_id IS NULL, not community, not operator_onramp', async (role) => {
    const r = await queryRecommendationsByRole(role, null, ['new'], 20, 0);
    expect(r.ok).toBe(true);
    expect(seen).toContain('user_id=is.null');
    expect(seen).toContain('source_type=neq.community');
    expect(seen).toContain('source_type=neq.operator_onramp');
  });

  it('community lineup is unchanged', async () => {
    await queryRecommendationsByRole('community', 'u-1', ['new'], 20, 0);
    expect(seen).toContain('source_type=eq.community');
    expect(seen).not.toContain('operator_onramp');
  });
});

describe('migration 20260926140000 — SQL contract', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const fn = (name: string) => {
    const start = sql.indexOf(`FUNCTION ${name}(`) >= 0 ? sql.indexOf(`FUNCTION ${name}(`) : sql.indexOf(`FUNCTION public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf('$$;', start));
  };

  it('insert_autopilot_recommendation keeps the live-duplicate check and adds a 30-day rejected block for system-wide rows only', () => {
    const body = fn('insert_autopilot_recommendation');
    expect(body).toContain("AND status IN ('new', 'snoozed')");
    expect(body).toContain('((user_id IS NULL AND p_user_id IS NULL) OR user_id = p_user_id)');
    expect(body).toMatch(/IF p_user_id IS NULL THEN[\s\S]*status = 'rejected'[\s\S]*user_id IS NULL[\s\S]*INTERVAL '30 days'/);
    // Same 18-parameter signature as 20260519000000 (grants survive CREATE OR REPLACE).
    expect(body).toContain('p_autonomy_level TEXT DEFAULT');
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it('both listing RPCs exclude operator_onramp', () => {
    expect(fn('get_autopilot_recommendations')).toContain("ar.source_type IS DISTINCT FROM 'operator_onramp'");
    expect(fn('get_autopilot_recommendations_count')).toContain("source_type IS DISTINCT FROM 'operator_onramp'");
  });

  it('cleanup never deletes developer findings (their plans/executions cascade)', () => {
    const body = fn('cleanup_expired_autopilot_recommendations');
    expect(body).toContain("source_type IS DISTINCT FROM 'dev_autopilot'");
    expect(body).toContain("source_type IS DISTINCT FROM 'dev_autopilot_impact'");
  });
});

describe('data fix 20260926140100 — narrowly scoped and idempotent', () => {
  const sql = fs.readFileSync(FIXUP, 'utf8').replace(/--.*$/gm, '');
  const updates = sql.split(/;\s*/).filter((s) => /UPDATE/i.test(s));

  it('has exactly three UPDATEs, each scoped to open system-wide rows of one source', () => {
    expect(updates).toHaveLength(3);
    const sources = ['roadmap', 'health', 'oasis'];
    updates.forEach((u, i) => {
      expect(u).toContain("SET status = 'rejected'");
      expect(u).toContain('ar.user_id IS NULL');
      expect(u).toContain("ar.status IN ('new', 'snoozed')");
      expect(u).toContain(`ar.source_type = '${sources[i]}'`);
    });
    expect(sql).not.toMatch(/\b(DELETE|DROP|TRUNCATE|INSERT)\b/i);
  });

  it('targets exactly the noise the new rules never create', () => {
    expect(updates[0]).toMatch(/is_terminal IS TRUE[\s\S]*'voided', 'deleted', 'rejected', 'cancelled'[\s\S]*<> 'approved'[\s\S]*365 days/);
    expect(updates[1]).toContain("('ANTHROPIC_API_KEY', 'GITHUB_TOKEN')");
    expect(updates[2]).toContain("LIKE 'voice.latency.%'");
    expect(updates[2]).toContain("LIKE 'dev\\_autopilot.%'");
  });
});
