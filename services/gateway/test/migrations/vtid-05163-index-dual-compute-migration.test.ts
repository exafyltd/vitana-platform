/**
 * VTID-05163: the B3 migration, the rollback data fix-up and the SQL CI
 * workflow, read from the files. Behaviour runs on a throwaway Postgres in
 * scripts/ci/sql-tests/run-index-dual-compute-test.sh (CI SQL-INDEX-DUAL-COMPUTE.yml):
 * the functional drift guard, routing, STABLE, grants, erasure, the rollback.
 *
 * Here: the key classes in SQL equal feature-spec.ts; the projection functions
 * are STABLE and never INSERT/UPDATE/DELETE; the workflow's path triggers
 * cover EVERY migration that defines the live Index function or its streak
 * helper (so a change to the live formula always runs the drift guard); the
 * live functions themselves are untouched by B3; Aurora-only bookkeeping.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DERIVED_FEATURE_KEYS, DEVICE_FEATURE_KEYS } from '../../src/services/health-features/feature-spec';
import { SELF_CODED_FEATURE_KEYS } from '../../src/services/health-features/index-dual-compute';
import { cutoverKeys } from '../../src/services/health-features/cutover';

const REPO = path.join(__dirname, '../../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const MIG = 'supabase/migrations/20261014100800_vtid_05163_index_dual_compute.sql';
const ROLLBACK = 'supabase/migrations/data-fixups/20261014100900_vtid_05163_rollback_health_features.sql';
const WORKFLOW = '.github/workflows/SQL-INDEX-DUAL-COMPUTE.yml';
const sql = strip(read(MIG));
const arrays = (text: string) => Array.from(text.matchAll(/ARRAY\[([^\]]*)\]/g)).map((m) => Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]));
const fnBody = (text: string, name: string) => {
  const at = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(at).toBeGreaterThan(-1);
  return text.slice(at, text.indexOf('$$;', text.indexOf('AS $$', at)) + 3);
};

/** Shell-style glob (as GitHub paths filters use it, for the patterns in this workflow). */
function globMatch(pattern: string, file: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  return re.test(file);
}

describe('VTID-05163 Index dual-compute migration (Aurora only)', () => {
  it('sorts after B2, carries the health store placement guard and a v2 precondition, one transaction', () => {
    expect(path.basename(MIG) > '20261014100700_vtid_05162_health_features_v2.sql').toBe(true);
    expect(read(MIG)).toContain('VTID-05163 health store placement guard');
    expect(sql).toContain("current_setting('vitana.health_store_target', true)");
    expect(sql).toContain("to_regclass('public.health_features_daily_v2') IS NULL");
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });

  it('the projection\'s key classes equal feature-spec.ts (device keys; coded self-logged keys)', () => {
    const rows = fnBody(sql, 'vitana_index_projected_feature_rows');
    const lists = arrays(rows);
    expect(lists).toHaveLength(4); // device + self, for each of the two tables
    expect(lists[0]).toEqual([...DEVICE_FEATURE_KEYS].sort((a, b) => DEVICE_FEATURE_KEYS.indexOf(a) - DEVICE_FEATURE_KEYS.indexOf(b)));
    expect([...lists[0]].sort()).toEqual([...DEVICE_FEATURE_KEYS].sort());
    expect([...lists[1]].sort()).toEqual([...SELF_CODED_FEATURE_KEYS].sort());
    expect(lists[2]).toEqual(lists[0]);
    expect(lists[3]).toEqual(lists[1]);
    expect([...lists[0], ...lists[1]].sort()).toEqual([...DERIVED_FEATURE_KEYS].sort());
  });

  it('every function is STABLE SECURITY DEFINER, writes nothing, EXECUTE for service_role only', () => {
    for (const name of ['vitana_index_projected_feature_rows', 'vitana_pillar_streak_days_projected', 'vitana_index_project_for_user']) {
      const body = fnBody(sql, name);
      expect(body).toMatch(/\n\s*STABLE\n\s*SECURITY DEFINER\n\s*SET search_path = public/);
      expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`));
    }
    expect(sql).not.toMatch(/GRANT [^;]*TO (anon|authenticated)/i);
  });

  it('never touches the live Index functions, the scores table, the trigger or health_features_daily\'s shape', () => {
    expect(sql).not.toMatch(/FUNCTION public\.health_compute_vitana_index/);
    expect(sql).not.toMatch(/FUNCTION public\.vitana_pillar_streak_days\(/);
    expect(sql).not.toMatch(/vitana_index_scores/);
    expect(sql).not.toMatch(/ALTER TABLE public\.health_features_daily\b/);
    expect(sql).not.toMatch(/TRIGGER/i);
  });

  it('vitana_index_dual_compute: one row per (member, date, scope), service-role only, no FK, Aurora-only bookkeeping', () => {
    const created = Array.from(sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)).map((m) => m[1]);
    expect(created).toEqual(['vitana_index_dual_compute']);
    expect(sql).toMatch(/vitana_index_dual_compute_key UNIQUE \(tenant_id, user_id, date, scope\)/);
    expect(sql).toContain('ALTER TABLE public.vitana_index_dual_compute ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.vitana_index_dual_compute FROM PUBLIC, anon, authenticated;');
    expect(sql).not.toMatch(/REFERENCES|CREATE POLICY|erasure_registry/);
    const baseline = JSON.parse(read('scripts/ci/migration-drift-baseline.json')) as { aurora_only_tables: Array<{ table: string; vtid: string }> };
    expect(baseline.aurora_only_tables).toContainEqual(expect.objectContaining({ table: 'vitana_index_dual_compute', vtid: 'VTID-05163' }));
    const rls = read('scripts/aws/aurora-restore-rls-parity.sql');
    const grants = read('scripts/aws/aurora-cutover-restore-grants.sql');
    expect(rls).toContain("to_regclass('public.vitana_index_dual_compute') IS NOT NULL THEN EXECUTE $SQL05163$ALTER TABLE public.vitana_index_dual_compute ENABLE ROW LEVEL SECURITY");
    expect(grants).toContain("to_regclass('public.vitana_index_dual_compute') IS NOT NULL THEN EXECUTE $SQL05163$GRANT ALL ON TABLE public.vitana_index_dual_compute TO service_role");
  });
});

describe('the rollback data fix-up (Change 14)', () => {
  const fix = read(ROLLBACK);
  const body = strip(fix);
  it('one transaction, lock_timeout, both settings required, a post-condition guard that raises', () => {
    expect(body).toMatch(/^BEGIN;/m);
    expect(body).toMatch(/^COMMIT;/m);
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
    expect(body).toContain("current_setting('vitana.health_features_rollback_mode', true)");
    expect(body).toContain("current_setting('vitana.health_features_rollback_date', true)");
    expect(body).toContain('rollback post-condition failed');
    expect(body).toMatch(/ON CONFLICT \(tenant_id, user_id, date, feature_key\) DO UPDATE/);
    expect(body).toMatch(/metadata ->> 'source' = 'derived_v2'/);
  });

  it('its key lists equal the cutover modes\' keys', () => {
    const lists = arrays(body.slice(body.indexOf('v_keys := ARRAY')));
    expect([...lists[0]].sort()).toEqual([...cutoverKeys('derived_device')].sort());
    expect([...lists[0], ...lists[1]].sort()).toEqual([...cutoverKeys('derived')].sort());
  });

  it('lives in data-fixups (never applied by a deploy) and says who may run it', () => {
    expect(ROLLBACK.startsWith('supabase/migrations/data-fixups/')).toBe(true);
    expect(fix).toContain('only the owner runs it');
  });
});

describe('SQL-INDEX-DUAL-COMPUTE.yml — the drift guard runs whenever the live formula changes', () => {
  const yml = read(WORKFLOW);
  const patterns = Array.from(yml.matchAll(/^\s+- '([^']+)'$/gm)).map((m) => m[1]);

  it('its path triggers cover every migration that defines the live Index function or its streak helper', () => {
    const dir = path.join(REPO, 'supabase/migrations');
    const defining = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
      .filter((f) => /CREATE OR REPLACE FUNCTION public\.(health_compute_vitana_index_for_user|vitana_pillar_streak_days)\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
      .map((f) => `supabase/migrations/${f}`);
    expect(defining.length).toBeGreaterThanOrEqual(3);
    for (const f of defining) expect([f, patterns.some((p) => globMatch(p, f))]).toEqual([f, true]);
    for (const f of [MIG, ROLLBACK, 'scripts/ci/sql-tests/run-index-dual-compute-test.sh', WORKFLOW]) {
      expect([f, patterns.some((p) => globMatch(p, f))]).toEqual([f, true]);
    }
  });

  it('runs the script on a throwaway postgres:16 and asserts every PASS line', () => {
    expect(yml).toContain('image: postgres:16');
    expect(yml).toContain('scripts/ci/sql-tests/run-index-dual-compute-test.sh');
    for (const line of ['drift guard', 'index dual compute', 'rollback fix-up', 'placement guard']) expect(yml).toContain(`'^PASS vtid-05163 ${line}'`);
    const runner = read('scripts/ci/sql-tests/run-index-dual-compute-test.sh');
    expect(runner).toMatch(/\*supabase\*\|\*amazonaws\*\|\*rds\*/);
    expect(runner).toContain('health_compute_vitana_index_for_user');
    expect(runner).toContain('sort | tail -n 1'); // the NEWEST defining migration is the one compared
  });
});
