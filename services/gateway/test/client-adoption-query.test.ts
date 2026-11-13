/** VTID-05658 — adoption counts: native-only, Appilix-only, both, plain web. Query runner is an in-memory double. */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ADOPTION_SQL, classifyMember, getAdoptionCounts, summarizeAdoption, type MemberFacts,
} from '../src/services/client-adoption/adoption';

const m = (id: string, f: Partial<MemberFacts>): MemberFacts => ({
  tenant_id: 't', user_id: id, has_native: false, has_web: false, has_appilix: false, ...f,
});

describe('client-adoption query', () => {
  it('classifies each member kind', () => {
    expect(classifyMember({ has_native: true, has_appilix: false })).toBe('native');
    expect(classifyMember({ has_native: false, has_appilix: true })).toBe('appilix');
    expect(classifyMember({ has_native: true, has_appilix: true })).toBe('native');
    expect(classifyMember({ has_native: false, has_appilix: false })).toBe('web');
  });

  it('counts native-only, Appilix-only, both and plain-web members', () => {
    const c = summarizeAdoption([
      m('a', { has_native: true }),
      m('b', { has_appilix: true, has_web: true }),
      m('c', { has_native: true, has_appilix: true }),
      m('d', { has_web: true }),
      m('e', { has_web: true }),
    ]);
    expect(c).toMatchObject({ native: 2, appilix: 1, web: 2, total: 5, native_and_appilix: 1 });
    expect(c.native_share).toBeCloseTo(0.4);
  });

  it('empty window → zero share', () => {
    expect(summarizeAdoption([]).native_share).toBe(0);
  });

  it('runs the embedded SQL with the window and returns aggregates only', async () => {
    const run = jest.fn(async () => [m('a', { has_native: true })]);
    const c = await getAdoptionCounts(run, '2026-10-12', '2026-11-09');
    expect(run).toHaveBeenCalledWith(ADOPTION_SQL, ['2026-10-12', '2026-11-09']);
    expect(Object.keys(c).sort()).toEqual(['appilix', 'native', 'native_and_appilix', 'native_share', 'total', 'web']);
  });

  it('the SQL is a single read-only SELECT with the Appilix rule, and adoption.sql matches the embedded text', () => {
    const file = readFileSync(join(__dirname, '../src/services/client-adoption/adoption.sql'), 'utf8');
    expect(file).toContain(ADOPTION_SQL.trim().replace(/;$/, ''));
    const sql = ADOPTION_SQL.replace(/--.*$/gm, '');
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i);
    expect(sql).toContain("LIKE 'Appilix %'");
    expect(sql).toContain('revoked_at IS NULL');
  });

  it('migration: PK on all four, tenant_id, RLS on with no policy, 35-day purge', () => {
    const mig = readFileSync(
      join(__dirname, '../../../supabase/migrations/20261108150000_client_identity_daily_seen.sql'), 'utf8');
    expect(mig).toMatch(/PRIMARY KEY \(day, tenant_id, user_id, client_class\)/);
    expect(mig).toMatch(/tenant_id\s+UUID NOT NULL/);
    expect(mig).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(mig).not.toMatch(/CREATE POLICY/i);
    expect(mig).toMatch(/- 35/);
  });
});
