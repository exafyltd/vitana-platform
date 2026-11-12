/**
 * VTID-05493 (mt-tenant-admin-r2 / tenant-lifecycle-db) — static pins over the lane's files.
 * Behaviour is proven by pgtap/vtid_05493_tenant_lifecycle.test.sql (PGlite evidence in outputs/); this suite pins that
 * the migrations, rollbacks, read-only checks, queue rows and drift baseline exist and keep their safety properties.
 * It lives here, not in services/gateway/test, because the lane's allowed paths do not include the gateway test folder.
 * Run: node --test docs/validation/VTID-05493/static-pins.test.mts   (node >= 22.18, no dependencies)
 */
import { describe as d, it as t } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const describe = d;
type Fn = () => void;
const fmt = (s: string, a: unknown): string => s.replace('%s', String(Array.isArray(a) ? a[0] : a));
const it: any = (name: string, fn: Fn) => t(name, fn);
it.each = (rows: any[]) => (name: string, fn: (...a: any[]) => void) => {
  for (const r of rows) t(fmt(name, r), () => fn(...(Array.isArray(r) ? r : [r])));
};
const matcher = (v: any, neg: boolean) => {
  const chk = (ok: boolean, msg: string) => assert.ok(neg ? !ok : ok, (neg ? 'expected NOT: ' : 'expected: ') + msg);
  return {
    toMatch: (re: RegExp) => chk(re.test(String(v)), `${re} against ${String(v).slice(0, 120)}`),
    toContain: (x: unknown) => chk(typeof v === 'string' ? v.includes(String(x)) : v.includes(x), `contain ${String(x)}`),
    toBe: (x: unknown) => chk(Object.is(v, x), `${String(v)} is ${String(x)}`),
    toEqual: (x: unknown) => { if (neg) assert.notDeepEqual(v, x); else assert.deepEqual(v, x); },
    toHaveLength: (n: number) => chk(v.length === n, `length ${v?.length} is ${n}`),
    toBeNull: () => chk(v === null, `${String(v)} is null`),
    toBeGreaterThan: (n: number) => chk(v > n, `${v} > ${n}`),
    toBeLessThan: (n: number) => chk(v < n, `${v} < ${n}`),
  };
};
const expect: any = (v: unknown) => ({ ...matcher(v, false), not: matcher(v, true) });

const ROOT = join(import.meta.dirname, '../../..');
const MIG_DIR = join(ROOT, 'supabase/migrations');
const VAL_DIR = join(ROOT, 'docs/validation/VTID-05493');

const DEACTIVATE = '20261102070300_vtid_05493_mt_tenant_deactivate.sql';
const ARCHIVE_SWITCH = '20261102070350_vtid_05493_mt_tenant_archive_switch.sql';
const ROLLBACK_DEACTIVATE = 'rollback-070300-tenant-deactivate.sql';
const ROLLBACK_ARCHIVE_SWITCH = 'rollback-070350-tenant-archive-switch.sql';

const read = (p: string): string => readFileSync(p, 'utf8');
/** SQL without comments, so prose in a header cannot satisfy or violate an assertion. */
const code = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const deactivate = (): string => read(join(MIG_DIR, DEACTIVATE));
const archiveSwitch = (): string => read(join(MIG_DIR, ARCHIVE_SWITCH));

describe('VTID-05493: migration files', () => {
  it('are exactly the two lane files, sorted around mt-community-isolation-r2 C3 (070160)', () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.includes('vtid_05493')).sort();
    expect(files).toEqual([DEACTIVATE, ARCHIVE_SWITCH]);
    expect(Number(DEACTIVATE.slice(0, 14))).toBeGreaterThan(20261102070160);
    expect(Number(ARCHIVE_SWITCH.slice(0, 14))).toBeGreaterThan(Number(DEACTIVATE.slice(0, 14)));
  });

  it.each([DEACTIVATE, ARCHIVE_SWITCH])('%s: one transaction with a lock_timeout', (f) => {
    const sql = code(read(join(MIG_DIR, f)));
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s'/);
    expect(sql.match(/^\s*BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT;/gm)).toHaveLength(1);
  });

  it('the ALTER TABLE on tenants retries on lock_not_available', () => {
    const sql = code(archiveSwitch());
    expect(sql).toMatch(/ALTER TABLE public\.tenants ADD COLUMN IF NOT EXISTS archived_at timestamptz/);
    expect(sql).toMatch(/EXCEPTION WHEN lock_not_available THEN/);
    expect(sql).toMatch(/v_try >= 5/);
  });

  it('is expand-only: no DROP, no DELETE, no TRUNCATE, no NOT NULL / DEFAULT on the new column', () => {
    for (const sql of [code(deactivate()), code(archiveSwitch())]) {
      expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    }
    expect(code(archiveSwitch())).not.toMatch(/archived_at\s+timestamptz\s+(NOT NULL|DEFAULT)/i);
  });

  it('adds no RLS policy and no bare current_tenant_id()', () => {
    for (const sql of [code(deactivate()), code(archiveSwitch())]) {
      expect(sql).not.toMatch(/CREATE\s+POLICY|ALTER\s+POLICY/i);
      expect(sql).not.toMatch(/current_tenant_id\s*\(/);
    }
  });

  it('snapshots tenants.is_active before any change and closes the snapshot table to clients', () => {
    const sql = code(deactivate());
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.bak_vtid_05493_tenant_lifecycle AS/);
    expect(sql).toMatch(/REVOKE ALL ON public\.bak_vtid_05493_tenant_lifecycle FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });
});

describe('VTID-05493: lifecycle RPCs', () => {
  it.each([
    ['deactivate_tenant', () => code(deactivate())],
    ['archive_tenant', () => code(archiveSwitch())],
  ] as const)('%s: SECURITY DEFINER with a pinned search_path, guards, service_role only', (name, get) => {
    const sql = get();
    const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(p_slug text\\)[\\s\\S]*?\\$fn\\$;`).exec(sql);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path = public, pg_catalog/);
    for (const w of ['INVALID_SLUG', 'TENANT_NOT_FOUND', 'DEFAULT_TENANT_PROTECTED', 'PLATFORM_TENANT_PROTECTED']) {
      expect(body).toContain(w);
    }
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(text\\) FROM PUBLIC, anon, authenticated`));
    expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(text\\) TO service_role`));
    expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(text\\) TO (authenticated|anon|PUBLIC)`));
  });

  it('are idempotent: the UPDATE only touches a row that still needs the change', () => {
    expect(code(deactivate())).toMatch(/SET is_active = false WHERE tenant_id = v_t\.tenant_id AND is_active;/);
    expect(code(archiveSwitch())).toMatch(/WHERE tenant_id = v_t\.tenant_id AND \(is_active OR archived_at IS NULL\)/);
    expect(code(archiveSwitch())).toMatch(/archived_at = coalesce\(archived_at, now\(\)\)/);
  });
});

describe('VTID-05493: closing switch RPC', () => {
  const body = (): string => {
    const m = /CREATE OR REPLACE FUNCTION public\.switch_to_tenant_by_slug[\s\S]*?\$function\$;/.exec(code(archiveSwitch()));
    expect(m).not.toBeNull();
    return m![0];
  };

  it('keeps the VTID-05043 contract (open_signup join rule, TENANT_NOT_JOINABLE, grants)', () => {
    const b = body();
    expect(b).toMatch(/ELSIF tenant_record\.open_signup THEN/);
    expect(b).toMatch(/RAISE EXCEPTION 'TENANT_NOT_JOINABLE' USING ERRCODE = '42501'/);
    expect(code(archiveSwitch())).toMatch(/REVOKE EXECUTE ON FUNCTION public\.switch_to_tenant_by_slug\(text\) FROM PUBLIC, anon/);
    expect(code(archiveSwitch())).toMatch(/GRANT EXECUTE ON FUNCTION public\.switch_to_tenant_by_slug\(text\) TO authenticated/);
  });

  it('resolves a member of an inactive tenant to the active default tenant, never a lockout', () => {
    const b = body();
    expect(b).toMatch(/IF NOT tenant_record\.is_active AND NOT v_is_exafy THEN/);
    expect(b).toMatch(/WHERE d\.is_default AND coalesce\(d\.is_active, true\)/);
    expect(b).toMatch(/RAISE EXCEPTION 'NO_DEFAULT_TENANT'/);
  });

  it('lets a non-member nowhere near a deactivated tenant and an exafy admin still switch to it', () => {
    const b = body();
    const gate = /IF NOT tenant_record\.is_active AND NOT v_is_exafy THEN\s+IF NOT v_is_member THEN\s+RAISE EXCEPTION 'TENANT_NOT_JOINABLE'/.exec(b);
    expect(gate).not.toBeNull();
  });

  it('audits the fallback and stays write-free on a repeat call', () => {
    const b = body();
    expect(b).toMatch(/'requested_slug', p_tenant_slug, 'fallback', true/);
    expect(b).toMatch(/IF v_switched > 0 OR v_created > 0 THEN/);
    expect(b).toMatch(/IS DISTINCT FROM tenant_record\.tenant_id::text/);
  });

  it('does not touch current_tenant_id() (an RLS-wide helper; out of this lane)', () => {
    expect(code(archiveSwitch())).not.toMatch(/FUNCTION public\.current_tenant_id/);
  });
});

describe('VTID-05493: rollbacks and read-only checks', () => {
  it.each([ROLLBACK_DEACTIVATE, ROLLBACK_ARCHIVE_SWITCH, 'live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql'])('%s exists', (f) => {
    expect(existsSync(join(VAL_DIR, f))).toBe(true);
  });

  it('the read-only checks are SELECT only', () => {
    for (const f of ['live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql']) {
      const sql = code(read(join(VAL_DIR, f)));
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    }
  });

  it('rollback-070350 restores the VTID-05043 body, restores is_active from the snapshot, then drops the column', () => {
    const sql = code(read(join(VAL_DIR, ROLLBACK_ARCHIVE_SWITCH)));
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.switch_to_tenant_by_slug/);
    expect(sql).not.toMatch(/is_default/);
    expect(sql).toMatch(/open_signup/);
    expect(sql.indexOf('bak_vtid_05493_tenant_lifecycle')).toBeGreaterThan(-1);
    expect(sql.indexOf('SET is_active = b.is_active')).toBeLessThan(sql.indexOf('DROP COLUMN IF EXISTS archived_at'));
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.archive_tenant\(text\)/);
  });

  it('rollback-070300 refuses while archive_tenant exists and restores is_active before dropping the function', () => {
    const sql = code(read(join(VAL_DIR, ROLLBACK_DEACTIVATE)));
    expect(sql).toMatch(/to_regprocedure\('public\.archive_tenant\(text\)'\) IS NOT NULL/);
    expect(sql.indexOf('SET is_active = b.is_active')).toBeLessThan(sql.indexOf('DROP FUNCTION IF EXISTS public.deactivate_tenant'));
  });
});

describe('VTID-05493: queue rows and drift baseline', () => {
  it('MIGRATION-QUEUE lists both files with their rollbacks', () => {
    const q = read(join(ROOT, 'docs/multitenancy/MIGRATION-QUEUE.md'));
    expect(q).toContain(DEACTIVATE);
    expect(q).toContain(ARCHIVE_SWITCH);
    expect(q).toContain(`docs/validation/VTID-05493/${ROLLBACK_DEACTIVATE}`);
    expect(q).toContain(`docs/validation/VTID-05493/${ROLLBACK_ARCHIVE_SWITCH}`);
  });

  it('the not-yet-live snapshot table is in the drift baseline and the count matches', () => {
    const b = JSON.parse(read(join(ROOT, 'scripts/ci/migration-drift-baseline.json')));
    expect(b.known_missing_tables).toContain('bak_vtid_05493_tenant_lifecycle');
    expect(b.count).toBe(b.known_missing_tables.length);
  });
});
