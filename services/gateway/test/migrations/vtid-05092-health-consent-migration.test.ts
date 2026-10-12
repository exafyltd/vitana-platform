/**
 * VTID-05092: the health consent migration's safety properties, read from the
 * file. Its behaviour (validation codes, idempotency, one transaction,
 * append-only, privileges as real statements) is tested on a throwaway
 * Postgres by scripts/ci/sql-tests/run-health-consent-test.sh
 * (CI: SQL-HEALTH-CONSENT.yml).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '../../../..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const file = fs.readdirSync(MIGRATIONS).find((f) => /_vtid_05092_health_consent_categories\.sql$/.test(f)) ?? '';
const sql = file ? fs.readFileSync(path.join(MIGRATIONS, file), 'utf8') : '';
const code = sql.replace(/--[^\n]*/g, '');
const FN_SIG = 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)';

describe('VTID-05092 health consent migration', () => {
  it('exists', () => {
    expect(file).toBe('20261012180000_vtid_05092_health_consent_categories.sql');
  });

  it('is additive: no table/column drop, no delete, no truncate; only the granted_via check and the trigger are replaced', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION)\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\s+(TABLE\s+)?public\./i);
    const drops = code.match(/\bDROP\s+(CONSTRAINT|TRIGGER|POLICY)\b[^;]*/gi) ?? [];
    expect(drops).toHaveLength(3);
    expect(drops.join('\n')).toMatch(/DROP CONSTRAINT %I/);
    expect(drops.join('\n')).toMatch(/DROP TRIGGER IF EXISTS trg_data_sharing_consent_events_append_only/);
    expect(drops.join('\n')).toMatch(/DROP POLICY IF EXISTS health_consent_categories_select/);
  });

  it('seeds the five categories without overwriting a later version bump', () => {
    for (const key of ['wearables', 'partner_results', 'ai_health_analysis', 'health_data_analytics', 'community_insights']) {
      expect(code).toContain(`('${key}',`);
    }
    expect(code).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(code).toMatch(/\('partner_results',\s+'partner_integration', 'result_ingestion', TRUE,/);
  });

  it('has no default-on column: nothing defaults to granted', () => {
    expect(code).not.toMatch(/default_on|granted_by_default|default_granted/i);
    expect(code).toMatch(/processing_active BOOLEAN NOT NULL DEFAULT FALSE/);
    // the new consent columns carry no default at all
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS category_key TEXT REFERENCES public\.health_consent_categories\(key\),/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS text_version TEXT,\s+ADD COLUMN IF NOT EXISTS shown_locale TEXT;/);
  });

  it('the catalogue is readable by members and written by no browser role', () => {
    expect(code).toMatch(/ALTER TABLE public\.health_consent_categories ENABLE ROW LEVEL SECURITY;/);
    expect(code).toMatch(/FOR SELECT TO authenticated USING \(true\)/);
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.health_consent_categories FROM anon, authenticated;/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.health_consent_categories TO authenticated;/);
  });

  it('widens granted_via additively', () => {
    expect(code).toMatch(/'checkout_flow', 'settings_connected_apps', 'portal_admin_backfill',\s+'settings_privacy', 'partner_link_confirm'/);
  });

  it('revokes browser writes, explaining it is defense in depth', () => {
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.data_sharing_consents FROM anon, authenticated;/);
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.data_sharing_consent_events FROM anon, authenticated;/);
    expect(sql).toMatch(/revokes are defense in\s+-- depth/);
    expect(sql).toMatch(/already denied today/i);
  });

  it('makes events append-only: UPDATE trigger + UPDATE/DELETE revoked from service_role, no DELETE trigger (erase_user_data)', () => {
    expect(code).toMatch(/BEFORE UPDATE ON public\.data_sharing_consent_events\s+FOR EACH ROW EXECUTE FUNCTION public\.fn_data_sharing_consent_events_append_only\(\)/);
    expect(code).not.toMatch(/BEFORE (DELETE|UPDATE OR DELETE)/i);
    expect(code).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.data_sharing_consent_events FROM service_role;/);
    expect(code).not.toMatch(/FUNCTION\s+public\.erase_user_data/i); // the erasure function is not touched
  });

  it('fn_set_health_consent is SECURITY DEFINER with a fixed search_path, EXECUTE for service_role only', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_set_health_consent\(/);
    expect(code).toMatch(/RETURNS jsonb\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION ${FN_SIG} FROM ${role};`);
    }
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${FN_SIG} TO service_role;`);
    expect(code.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(1);
  });

  it('writes the consent and its event inside the one function body (no exception handler that could swallow the audit insert)', () => {
    const body = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.fn_set_health_consent('), code.indexOf("COMMENT ON FUNCTION public.fn_set_health_consent"));
    expect(body).toMatch(/INSERT INTO public\.data_sharing_consents/);
    expect(body).toMatch(/UPDATE public\.data_sharing_consents/);
    expect(body).toMatch(/INSERT INTO public\.data_sharing_consent_events/);
    expect(body).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
    expect(body).toMatch(/FOR UPDATE/);
    // the legacy label is only for partner_results; partners validated on grant only
    expect(body).toMatch(/p_text_version = 'legacy-03885' AND v_cat\.key = 'partner_results'/);
    expect(body).toMatch(/p_action = 'grant'\s+AND v_cat\.resource_type = 'partner_integration'/);
    expect(body).toMatch(/pr\.status IN \('active', 'sandbox'\)/);
  });

  it('adds the quarantine release column', () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS consent_order_id UUID REFERENCES public\.partner_health_test_orders\(id\) ON DELETE SET NULL;/);
  });
});

describe('VTID-05092 registries and parity scripts agree with the migration', () => {
  it('declares the OASIS event types', () => {
    const cicd = fs.readFileSync(path.join(__dirname, '../../src/types/cicd.ts'), 'utf8');
    expect(cicd).toContain("| 'health.consent.granted'");
    expect(cicd).toContain("| 'health.consent.revoked'");
  });

  it('the Aurora grants restore no longer gives browser roles writes on the consent tables', () => {
    const grants = fs.readFileSync(path.join(ROOT, 'scripts/aws/aurora-cutover-restore-grants.sql'), 'utf8');
    for (const t of ['data_sharing_consents', 'data_sharing_consent_events']) {
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(grants).not.toContain(`GRANT ${p} ON TABLE public.${t} TO anon;`);
        expect(grants).not.toContain(`GRANT ${p} ON TABLE public.${t} TO authenticated;`);
      }
    }
    expect(grants).not.toContain('GRANT UPDATE ON TABLE public.data_sharing_consent_events TO service_role;');
    expect(grants).not.toContain('GRANT DELETE ON TABLE public.data_sharing_consent_events TO service_role;');
    expect(grants).toContain('GRANT INSERT ON TABLE public.data_sharing_consent_events TO service_role;');
    expect(grants).toContain('GRANT UPDATE ON TABLE public.data_sharing_consents TO service_role;');
  });

  it('the Aurora RLS parity script carries the catalogue policy', () => {
    const rls = fs.readFileSync(path.join(ROOT, 'scripts/aws/aurora-restore-rls-parity.sql'), 'utf8');
    expect(rls).toMatch(/health_consent_categories ENABLE ROW LEVEL SECURITY/);
    expect(rls).toMatch(/CREATE POLICY health_consent_categories_select ON public\.health_consent_categories AS PERMISSIVE FOR SELECT TO authenticated USING \(true\)/);
  });
});
