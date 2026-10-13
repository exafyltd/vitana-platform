/**
 * VTID-05162: the B2 migration's safety properties, read from the files.
 * Behaviour is tested on a throwaway Postgres by
 * scripts/ci/sql-tests/run-health-features-v2-test.sh (CI: SQL-HEALTH-FEATURES-V2.yml).
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const MIG = 'supabase/migrations/20261014100700_vtid_05162_health_features_v2.sql';
const sql = strip(read(MIG));
const TABLES = ['health_features_daily_v2', 'health_features_daily_legacy_shadow', 'health_features_derivation_pending'];

describe('VTID-05162 health_features_v2 migration (Aurora only)', () => {
  it('sorts after B1, carries the health store placement guard, one transaction', () => {
    expect(path.basename(MIG) > '20261014100300_vtid_05161_user_integrations_revoke_browser_writes.sql').toBe(true);
    expect(read(MIG)).toContain('VTID-05162 health store placement guard');
    expect(sql).toContain("current_setting('vitana.health_store_target', true)");
    expect(sql).toContain("to_regclass('storage.objects') IS NOT NULL");
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });

  it('creates exactly the three tables, service-role only, no FK to auth.users', () => {
    const created = Array.from(sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)).map((m) => m[1]);
    expect(created).toEqual(TABLES);
    for (const t of TABLES) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT ALL ON public.${t} TO service_role;`);
    }
    expect(sql).not.toMatch(/GRANT [^;]*TO (anon|authenticated)/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/REFERENCES/i);
    expect(sql).not.toMatch(/erasure_registry/);
  });

  it('v2 and the shadow keep health_features_daily’s unique key; the marker is one per member-day', () => {
    expect(sql).toMatch(/health_features_daily_v2_unique UNIQUE \(tenant_id, user_id, date, feature_key\)/);
    expect(sql).toMatch(/health_features_daily_legacy_shadow_unique UNIQUE \(tenant_id, user_id, date, feature_key\)/);
    expect(sql).toMatch(/health_features_derivation_pending_key UNIQUE \(tenant_id, user_id, date\)/);
    expect(sql).toMatch(/derivation_version\s+text NOT NULL/);
    expect(sql).toMatch(/source_kinds\s+text\[\] NOT NULL/);
  });

  it('the drift baseline lists the three tables as Aurora-only; the parity scripts carry guarded lines', () => {
    const baseline = JSON.parse(read('scripts/ci/migration-drift-baseline.json')) as { aurora_only_tables: Array<{ table: string; vtid: string }> };
    for (const t of TABLES) expect(baseline.aurora_only_tables).toContainEqual(expect.objectContaining({ table: t, vtid: 'VTID-05162' }));
    const rls = read('scripts/aws/aurora-restore-rls-parity.sql');
    const grants = read('scripts/aws/aurora-cutover-restore-grants.sql');
    for (const t of TABLES) {
      expect(rls).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(grants).toContain(`GRANT ALL ON TABLE public.${t} TO service_role`);
    }
    for (const f of [rls, grants]) {
      for (const st of f.split(/;\s*\n/)) {
        const body = st.replace(/^\s*--.*$/gm, '').trim();
        for (const t of TABLES) if (new RegExp(`\\b${t}\\b`).test(body)) expect(body).toContain(`to_regclass('public.${t}')`);
        if (/health_features_(daily_v2|daily_legacy_shadow|derivation_pending)/.test(body)) expect(body).not.toMatch(/TO (anon|authenticated)/);
      }
    }
  });
});
