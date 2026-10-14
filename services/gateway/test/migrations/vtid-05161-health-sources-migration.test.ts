/**
 * VTID-05161: the B1 migrations' safety properties, read from the files.
 * Behaviour is tested on a throwaway Postgres by
 * scripts/ci/sql-tests/run-health-sources-test.sh (CI: SQL-HEALTH-SOURCES.yml).
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const SOURCES = 'supabase/migrations/20261014100200_vtid_05161_health_sources.sql';
const REVOKE = 'supabase/migrations/20261014100300_vtid_05161_user_integrations_revoke_browser_writes.sql';
const sources = strip(read(SOURCES));
const revoke = strip(read(REVOKE));

describe('VTID-05161 health_sources migration (Aurora only)', () => {
  it('sorts after the A1 store migration and carries the same placement guard', () => {
    expect(path.basename(SOURCES) > '20261014100100_vtid_05158_health_store.sql').toBe(true);
    expect(path.basename(REVOKE) > path.basename(SOURCES)).toBe(true);
    expect(sources).toMatch(/^BEGIN;/m);
    expect(sources).toMatch(/^COMMIT;/m);
    expect(sources).toContain("current_setting('vitana.health_store_target', true)");
    expect(sources).toContain("to_regclass('storage.objects') IS NOT NULL");
  });

  it('member own-read only, no browser writes, gateway-only writes', () => {
    expect(sources).toContain('ALTER TABLE public.health_sources ENABLE ROW LEVEL SECURITY;');
    expect(sources).toContain('REVOKE ALL ON public.health_sources FROM PUBLIC, anon, authenticated;');
    expect(sources).toContain('GRANT SELECT ON public.health_sources TO authenticated;');
    expect(sources).toMatch(/CREATE POLICY health_sources_own_read ON public\.health_sources FOR SELECT TO authenticated\s+USING \(user_id = auth\.uid\(\)\);/);
    expect(sources).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (anon|authenticated)/i);
    expect(sources).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it('connector_id is nullable with an FK to connector_registry; no FK to auth.users; token_ref is a pointer, never a token', () => {
    expect(sources).toMatch(/connector_id\s+text NULL\s+CONSTRAINT health_sources_connector_fk REFERENCES public\.connector_registry\(id\)/);
    expect(sources).not.toMatch(/REFERENCES auth\.users/i);
    expect(sources).toContain("token_ref ~ '^user_connections:");
    expect(sources).not.toMatch(/\b(access|refresh)_token\b\s+text/);
    expect(sources).not.toMatch(/\b(access|refresh)_token\b[^;]*INSERT INTO public\.health_sources/s);
  });

  it('backfills only the health half of user_connections, and every user_integrations row it can place', () => {
    expect(sources).toContain("WHERE uc.category IN ('wearable', 'aggregator')");
    expect(sources.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2);
    expect(sources).toContain("WHEN ui.integration_id = 'manual-entry' THEN 'manual'");
    expect(sources).toContain('ORDER BY ut.is_primary DESC, ut.created_at, ut.tenant_id');
    expect(sources).toContain('RAISE NOTICE');
  });

  it('the reconcile function is STABLE SECURITY DEFINER and service_role only', () => {
    expect(sources).toMatch(/health_sources_reconcile_counts\(\)\s+RETURNS jsonb\s+LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(sources).toContain('REVOKE ALL ON FUNCTION public.health_sources_reconcile_counts() FROM PUBLIC, anon, authenticated;');
    expect(sources).toContain('GRANT EXECUTE ON FUNCTION public.health_sources_reconcile_counts() TO service_role;');
  });
});

describe('VTID-05161 user_integrations browser-write revoke (Supabase target)', () => {
  it('revokes browser writes, replaces FOR ALL with SELECT-only, and checks the end state', () => {
    expect(revoke).not.toContain('placement guard');
    expect(revoke).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_integrations FROM PUBLIC, anon, authenticated;');
    expect(revoke).toContain('DROP POLICY IF EXISTS user_integrations_owner_all ON public.user_integrations;');
    expect(revoke).toMatch(/CREATE POLICY user_integrations_owner_select ON public\.user_integrations\s+FOR SELECT TO authenticated/);
    expect(revoke).toContain("has_table_privilege(v_role, 'public.user_integrations', v_priv)");
    expect(revoke).not.toMatch(/GRANT /);
  });

  it('the Aurora parity scripts carry the same end state, and health_sources guarded', () => {
    const rls = read('scripts/aws/aurora-restore-rls-parity.sql');
    const grants = read('scripts/aws/aurora-cutover-restore-grants.sql');
    expect(rls).not.toContain('CREATE POLICY user_integrations_owner_all');
    expect(rls).toContain('CREATE POLICY user_integrations_owner_select ON public.user_integrations AS PERMISSIVE FOR SELECT TO authenticated');
    expect(grants).not.toMatch(/GRANT (INSERT|UPDATE|DELETE) ON TABLE public\.user_integrations TO authenticated;/);
    expect(grants).toMatch(/GRANT (INSERT|UPDATE|DELETE) ON TABLE public\.user_integrations TO service_role;/);
    for (const f of [rls, grants]) {
      for (const st of f.split(/;\s*\n/)) {
        const body = st.replace(/^\s*--.*$/gm, '').trim();
        if (/\bhealth_sources\b/.test(body)) expect(body).toContain("to_regclass('public.health_sources')");
      }
    }
    expect(rls).toContain('CREATE POLICY health_sources_own_read ON public.health_sources');
    expect(grants).toContain('GRANT SELECT ON TABLE public.health_sources TO authenticated');
  });
});
