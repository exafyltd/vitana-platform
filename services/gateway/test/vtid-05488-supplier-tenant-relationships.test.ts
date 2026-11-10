/**
 * VTID-05488 (mt-discover-r2 / supplier-relationships-db) — static pins over the lane's files.
 * Behaviour is proven by the pgTAP file docs/validation/VTID-05488/pgtap/vtid_05488_supplier_tenant_relationships.test.sql
 * (PGlite evidence in docs/validation/VTID-05488/outputs/); this suite pins that the migrations, rollbacks, read-only
 * checks, queue rows and drift baseline exist and keep their safety properties.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const MIG_DIR = join(ROOT, 'supabase/migrations');
const VAL_DIR = join(ROOT, 'docs/validation/VTID-05488');

const MIGRATIONS = {
  relationships: '20261102120000_vtid_05488_supplier_tenant_relationships.sql',
  distribution: '20261102120100_vtid_05488_products_distribution.sql',
  partnerTenant: '20261102120200_vtid_05488_partner_tenant_backfill.sql',
  rls: '20261102120300_vtid_05488_products_merchants_tenant_rls.sql',
} as const;
const ROLLBACKS = [
  'rollback-120000-supplier-tenant-relationships.sql',
  'rollback-120100-products-distribution.sql',
  'rollback-120200-partner-tenant-backfill.sql',
  'rollback-120300-products-merchants-tenant-rls.sql',
];

const read = (p: string): string => readFileSync(p, 'utf8');
const mig = (k: keyof typeof MIGRATIONS): string => read(join(MIG_DIR, MIGRATIONS[k]));
/** SQL without comments, so prose in a header cannot satisfy or violate an assertion. */
const code = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('VTID-05488: migration files', () => {
  it('exist, in the lane range 20261102120000-125959, and are the only VTID-05488 migrations', () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.includes('vtid_05488')).sort();
    expect(files).toEqual(Object.values(MIGRATIONS).sort());
    for (const f of files) {
      const v = Number(f.slice(0, 14));
      expect(v).toBeGreaterThanOrEqual(20261102120000);
      expect(v).toBeLessThanOrEqual(20261102125959);
    }
  });

  it.each(Object.keys(MIGRATIONS) as (keyof typeof MIGRATIONS)[])('%s: lock_timeout, retry on lock_not_available, own transaction', (k) => {
    const sql = code(mig(k));
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(sql).toMatch(/EXCEPTION WHEN lock_not_available THEN/);
    expect(sql).toMatch(/v_try >= 5/);
    expect(sql.match(/^\s*BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT;/gm)).toHaveLength(1);
  });

  it('none of them references is_member() or tenant_id_for_policies(), code or comment', () => {
    for (const k of Object.keys(MIGRATIONS) as (keyof typeof MIGRATIONS)[]) {
      expect(mig(k)).not.toMatch(/is_member|tenant_id_for_policies/);
    }
  });

  it('none of them adds a product_orders column (D26 reuses product_orders.tenant_id)', () => {
    for (const k of Object.keys(MIGRATIONS) as (keyof typeof MIGRATIONS)[]) {
      expect(code(mig(k))).not.toMatch(/product_orders/i);
    }
  });

  it('none of them destroys data: no DROP TABLE, DROP COLUMN, TRUNCATE or DELETE', () => {
    for (const k of Object.keys(MIGRATIONS) as (keyof typeof MIGRATIONS)[]) {
      expect(code(mig(k))).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    }
  });
});

describe('VTID-05488 D1: supplier_tenant_relationships', () => {
  const sql = code(mig('relationships'));

  it('has the designed columns and the status vocabulary', () => {
    for (const c of ['merchant_id', 'partner_organization_id', 'tenant_id', 'status', 'vertical_key', 'created_at', 'updated_at', 'decided_at']) {
      expect(sql).toMatch(new RegExp(`\\b${c}\\b`));
    }
    expect(sql).toMatch(/CHECK \(status IN \('proposed', 'active', 'declined', 'suspended'\)\)/);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id\) REFERENCES public\.tenants\(%I\)/);
  });

  it('RLS: members read through an inline user_tenants EXISTS on auth.uid(); service_role ALL; no client writes', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM public\.user_tenants ut\s+WHERE ut\.tenant_id = supplier_tenant_relationships\.tenant_id\s+AND ut\.user_id = auth\.uid\(\)\)\)/);
    expect(sql).toMatch(/FOR ALL TO service_role/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.supplier_tenant_relationships FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.supplier_tenant_relationships TO authenticated/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO authenticated/i);
  });

  it("seeds existing merchants active for the 'maxina' tenant only", () => {
    expect(sql).toMatch(/INSERT INTO public\.supplier_tenant_relationships/);
    expect(sql).toMatch(/WHERE t\.slug = 'maxina'/);
    expect(sql).toMatch(/'active'/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe('VTID-05488 D2: products.distribution', () => {
  const sql = code(mig('distribution'));
  it("adds distribution text NOT NULL DEFAULT 'community' (default stays) with a community|network CHECK", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS distribution text NOT NULL DEFAULT 'community'/);
    expect(sql).toMatch(/CHECK \(distribution IN \('community', 'network'\)\)/);
    expect(sql).not.toMatch(/DROP DEFAULT/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.products/i);
  });
  it('does not scan products under the ADD COLUMN exclusive lock: CHECK stays NOT VALID, no VALIDATE', () => {
    expect(sql).toMatch(/CHECK \(distribution IN \('community', 'network'\)\) NOT VALID/);
    expect(sql).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
  });
});

describe('VTID-05488 D3: partner_tenant backfill', () => {
  const sql = code(mig('partnerTenant'));
  it('snapshots first, never overwrites the snapshot, and is expand-only (tenant_id text untouched)', () => {
    const snap = sql.indexOf('CREATE TABLE IF NOT EXISTS public.bak_vtid_05488_partner_tenant');
    const col = sql.indexOf('ADD COLUMN IF NOT EXISTS tenant_uuid');
    const upd = sql.indexOf('UPDATE public.partner_tenant');
    expect(snap).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(col);
    expect(col).toBeLessThan(upd);
    expect(sql).not.toMatch(/ALTER COLUMN tenant_id/i);
    expect(sql).not.toMatch(/SET\s+tenant_id\b/i);
  });
  it('maps only unambiguous rows and leaves the rest NULL', () => {
    expect(sql).toMatch(/HAVING count\(DISTINCT tkey\) = 1/);
    expect(sql).toMatch(/WHERE p\.id = u\.pid AND p\.tenant_uuid IS NULL/);
    expect(sql).toMatch(/RETURN;/); // no partner_tenant table: nothing to do
  });
});

describe('VTID-05488 D4: helper and tenant-scoped RLS', () => {
  const sql = code(mig('rls'));
  it('discover_tenant_gate_enabled() is STABLE SECURITY DEFINER with a pinned search_path and no PUBLIC/anon execute', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.discover_tenant_gate_enabled\(\)\s+RETURNS boolean\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_catalog/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.discover_tenant_gate_enabled\(\) FROM PUBLIC, anon/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.discover_tenant_gate_enabled\(\) TO authenticated, service_role/);
  });
  it('covers both branches: NULL tenant = any gate on; non-NULL tenant = its own flag, false without a row', () => {
    expect(sql).toMatch(/v_tenant uuid := public\.current_tenant_id\(\);/);
    expect(sql).toMatch(/IF v_tenant IS NULL THEN\s+RETURN EXISTS \(SELECT 1 FROM public\.tenant_settings ts/);
    expect(sql).toMatch(/WHERE ts\.tenant_id = v_tenant;\s+RETURN coalesce\(v_on, false\)/);
    // the tenant is resolved exactly once inside the helper
    expect(code(sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('REVOKE ALL'))).match(/current_tenant_id\(\)/g)).toHaveLength(1);
  });
  it('replaces products_select and merchants_select with gate-guarded policies built on existing helpers only', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS products_select ON public\.products;\s+CREATE POLICY products_select ON public\.products\s+FOR SELECT TO authenticated/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS merchants_select ON public\.merchants;\s+CREATE POLICY merchants_select ON public\.merchants\s+FOR SELECT TO authenticated/);
    expect(sql.match(/NOT \(SELECT public\.discover_tenant_gate_enabled\(\)\)/g)).toHaveLength(2);
    expect(sql).toMatch(/distribution = 'network'/);
    expect(sql.match(/r\.tenant_id = \(SELECT public\.current_tenant_id\(\)\)/g)).toHaveLength(2);
    // each policy also ties the row to the caller (bare-policy lint, VTID-05465): membership through auth.uid()
    expect(sql.match(/ut\.user_id = \(SELECT auth\.uid\(\)\)/g)).toHaveLength(2);
    expect(sql.match(/r\.status = 'active'/g)).toHaveLength(2);
    expect(sql.match(/is_active = TRUE/g)!.length).toBeGreaterThanOrEqual(2);
    // inert default: no policy for anon is created
    expect(sql).not.toMatch(/TO anon/i);
  });
  it('refuses to run before 120000 and 120100', () => {
    expect(sql).toMatch(/public\.supplier_tenant_relationships is missing \(apply 20261102120000 first\)/);
    expect(sql).toMatch(/public\.products\.distribution is missing \(apply 20261102120100 first\)/);
  });
});

describe('VTID-05488 D5: rollbacks, read-only checks, evidence', () => {
  it.each(ROLLBACKS)('%s exists, is transactional and bounded by lock_timeout', (f) => {
    const p = join(VAL_DIR, f);
    expect(existsSync(p)).toBe(true);
    const sql = code(read(p));
    expect(sql).toMatch(/BEGIN;/);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(sql).toMatch(/COMMIT;/);
  });

  it('the policy rollback restores the is_active-only policies and drops the helper', () => {
    const sql = code(read(join(VAL_DIR, 'rollback-120300-products-merchants-tenant-rls.sql')));
    expect(sql).toMatch(/CREATE POLICY products_select ON public\.products FOR SELECT TO authenticated USING \(is_active = TRUE\)/);
    expect(sql).toMatch(/CREATE POLICY merchants_select ON public\.merchants FOR SELECT TO authenticated USING \(is_active = TRUE\)/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.discover_tenant_gate_enabled\(\)/);
  });

  it.each(['live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql'])('%s is read-only', (f) => {
    const sql = code(read(join(VAL_DIR, f))).replace(/'[^']*'/g, "''"); // string literals such as has_table_privilege(..., 'INSERT')
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    expect(sql).toMatch(/\bSELECT\b/i);
  });

  it('ships the validation set and the pgTAP file', () => {
    for (const f of ['acceptance.md', 'scope.json', 'staging-tests.json', 'plan-sparring.md', 'pgtap/vtid_05488_supplier_tenant_relationships.test.sql', 'pgtap/vtid_05488_fixture.sql']) {
      expect(existsSync(join(VAL_DIR, f))).toBe(true);
    }
    const pgtap = read(join(VAL_DIR, 'pgtap/vtid_05488_supplier_tenant_relationships.test.sql'));
    expect(pgtap).toMatch(/has_function\('public', 'discover_tenant_gate_enabled'/);
    expect(pgtap).toMatch(/SELECT plan\(\d+\);/);
  });
});

describe('VTID-05488: queue rows and drift baseline', () => {
  const queue = read(join(ROOT, 'docs/multitenancy/MIGRATION-QUEUE.md'));
  const rows = queue.split('\n').filter((l) => /^\| \d+ \|/.test(l));

  it('MIGRATION-QUEUE.md has one queued-pending-approval row per migration, in order, with its rollback', () => {
    const mine = rows.filter((l) => l.includes('vtid_05488'));
    expect(mine).toHaveLength(4);
    const files = Object.values(MIGRATIONS);
    mine.forEach((row, i) => {
      expect(row).toContain(files[i]);
      expect(row).toContain('queued (pending owner approval)');
      expect(row).toContain('owner approval required (collaboration §7d)');
      expect(row).toMatch(/docs\/validation\/VTID-05488\/rollback-12\d{4}-[a-z-]+\.sql/);
    });
    const nums = mine.map((r) => Number(/^\| (\d+) \|/.exec(r)![1]));
    expect(nums).toEqual([nums[0], nums[0] + 1, nums[0] + 2, nums[0] + 3]);
    const all = rows.map((r) => Number(/^\| (\d+) \|/.exec(r)![1]));
    expect(new Set(all).size).toBe(all.length); // no duplicate row number
    expect(mine[3]).toMatch(/#\d+, #\d+/); // the policy migration depends on the table and the column
  });

  it('the not-yet-live tables are in the drift baseline and the count matches', () => {
    const base = JSON.parse(read(join(ROOT, 'scripts/ci/migration-drift-baseline.json')));
    expect(base.known_missing_tables).toEqual(expect.arrayContaining(['supplier_tenant_relationships', 'bak_vtid_05488_partner_tenant']));
    expect(base.count).toBe(base.known_missing_tables.length);
    expect([...base.known_missing_tables].sort()).toEqual(base.known_missing_tables);
  });
});
