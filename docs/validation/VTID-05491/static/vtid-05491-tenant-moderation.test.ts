/**
 * VTID-05491 (mt-tenant-admin-r2 / tenant-admin-moderation-db) - static pins over the lane's files.
 * Behaviour is proven by pgTAP (docs/validation/VTID-05491/pgtap/, PGlite evidence in outputs/); this suite pins that the
 * three migrations, their rollbacks, the read-only checks and the queue rows exist and keep their safety properties.
 * Lives under docs/validation/VTID-05491/static/ because the lane's paths are migrations + queue + baseline only.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../..');
const MIG_DIR = join(ROOT, 'supabase/migrations');
const VAL_DIR = join(ROOT, 'docs/validation/VTID-05491');

const MIGRATIONS = {
  p2: '20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql',
  p3: '20261102070150_vtid_05491_mt_tenant_admin_p3_moderation.sql',
  scope: '20261102070600_vtid_05491_mt_moderator_tenant_scope.sql',
} as const;
const ROLLBACKS = ['rollback-070100-p2-moderation.sql', 'rollback-070150-p3-moderation.sql', 'rollback-070600-moderator-tenant-scope.sql'];
const CHECKS = ['live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql'];

const read = (p: string): string => readFileSync(p, 'utf8');
const mig = (k: keyof typeof MIGRATIONS): string => read(join(MIG_DIR, MIGRATIONS[k]));
const code = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const keys = Object.keys(MIGRATIONS) as (keyof typeof MIGRATIONS)[];

describe('VTID-05491: migration files', () => {
  it('exist, are the only VTID-05491 migrations, and sort around the reserved C3 slot 20261102070160', () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.includes('vtid_05491')).sort();
    expect(files).toEqual(Object.values(MIGRATIONS).sort());
    expect(Number(MIGRATIONS.p3.slice(0, 14))).toBeLessThan(20261102070160);
    expect(Number(MIGRATIONS.scope.slice(0, 14))).toBeGreaterThan(20261102070160);
    expect(readdirSync(MIG_DIR).some((f) => f.startsWith('20261102070160'))).toBe(false);
  });

  it.each(keys)('%s: lock_timeout, retry on lock_not_available, one transaction', (k) => {
    const sql = code(mig(k));
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(sql).toMatch(/EXCEPTION WHEN lock_not_available THEN/);
    expect(sql).toMatch(/v_try >= 5/);
    expect(sql.match(/^\s*BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT;/gm)).toHaveLength(1);
  });

  it('none of them destroys data: no DROP TABLE, DROP COLUMN, TRUNCATE or DELETE', () => {
    for (const k of keys) expect(code(mig(k))).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  });

  it('none of them uses a bare current_tenant_id() or the non-existent is_member()/tenant_id_for_policies()', () => {
    for (const k of keys) expect(code(mig(k))).not.toMatch(/current_tenant_id|is_member\(|tenant_id_for_policies/);
  });

  it('every SECURITY DEFINER function pins its search_path', () => {
    for (const k of keys) {
      const sql = code(mig(k));
      const defs = sql.match(/SECURITY DEFINER/g)?.length ?? 0;
      const pins = sql.match(/SET search_path = public, pg_catalog/g)?.length ?? 0;
      expect(pins).toBe(defs);
    }
  });

  it('P2 snapshots before it moves data, and only backfills rows still NULL', () => {
    const sql = code(mig('p2'));
    expect(sql.indexOf('bak_05491_content_reports')).toBeGreaterThan(-1);
    expect(sql.indexOf('bak_05491_content_reports')).toBeLessThan(sql.indexOf('UPDATE public.content_reports'));
    expect(sql.match(/tenant_id IS NULL/g)!.length).toBeGreaterThanOrEqual(3);
    expect(sql).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY|GRANT .* ON TABLE/i);
  });

  it('P2 never grants the internal helper to anon/authenticated', () => {
    expect(code(mig('p2'))).toMatch(/REVOKE ALL ON FUNCTION public\.moderation_home_tenant\(uuid\) FROM PUBLIC, anon, authenticated/);
  });

  it('P3 RPCs are not executable by anon and check the caller before reading', () => {
    const sql = code(mig('p3'));
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.moderation_list_reports\(uuid, text, int\) FROM PUBLIC, anon/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.moderation_resolve_report\(uuid, text, text, text\) FROM PUBLIC, anon/);
    expect(sql.match(/NOT public\.is_tenant_moderator\(/g)).toHaveLength(2);
    expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY/i);
  });

  it('scope migration keeps the policy names and has a legacy branch (flag off = today)', () => {
    const sql = code(mig('scope'));
    for (const n of ['Staff and admins can view all reports', 'Staff and admins can update reports', 'Admins view moderation actions']) {
      expect(sql).toContain(`"${n}"`);
    }
    expect(sql).toMatch(/ELSE EXISTS \(SELECT 1 FROM public\.memberships/);
    expect(sql).toMatch(/ELSE public\.is_community_moderator\(\)/);
    expect(sql).toMatch(/exafy_admin/);
    expect(sql).toMatch(/auth\.uid\(\)/);
    expect(sql).not.toMatch(/Users can create content reports/);
  });
});

describe('VTID-05491: rollbacks and read-only checks', () => {
  it.each(ROLLBACKS)('%s exists, is transactional and lock-timed', (f) => {
    expect(existsSync(join(VAL_DIR, f))).toBe(true);
    const sql = code(read(join(VAL_DIR, f)));
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(sql.match(/^\s*BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT;/gm)).toHaveLength(1);
  });

  it('the P2 and P3 rollbacks refuse while a later file is still applied; no rollback drops a snapshot', () => {
    expect(code(read(join(VAL_DIR, ROLLBACKS[0])))).toMatch(/RAISE EXCEPTION[^;]*roll back 20261102070150 first/);
    expect(code(read(join(VAL_DIR, ROLLBACKS[1])))).toMatch(/RAISE EXCEPTION[^;]*roll back 20261102070600 first/);
    for (const f of ROLLBACKS) expect(code(read(join(VAL_DIR, f)))).not.toMatch(/bak_05491|legacy_archive/);
  });

  it('the scope rollback restores the three original policies', () => {
    const sql = code(read(join(VAL_DIR, ROLLBACKS[2])));
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(3);
    expect(sql).not.toMatch(/moderator_tenant_scope_enabled\(tenant_id\)/);
  });

  it.each(CHECKS)('%s is SELECT-only', (f) => {
    const sql = code(read(join(VAL_DIR, f)));
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/i);
  });
});

describe('VTID-05491: queue rows', () => {
  it('MIGRATION-QUEUE lists the three files in order P2 -> P3 -> scope, queued pending owner approval', () => {
    const q = read(join(ROOT, 'docs/multitenancy/MIGRATION-QUEUE.md'));
    const at = keys.map((k) => q.indexOf(MIGRATIONS[k]));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect(at[0]).toBeLessThan(at[1]);
    expect(at[1]).toBeLessThan(at[2]);
    for (const k of keys) {
      const row = q.split('\n').find((l) => l.includes(MIGRATIONS[k]))!;
      expect(row).toMatch(/queued \(pending owner approval\)/);
      expect(row).toContain('docs/validation/VTID-05491/rollback-');
    }
  });
});
