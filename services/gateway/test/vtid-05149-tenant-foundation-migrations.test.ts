/**
 * VTID-05149 — static pins on the three tenant-foundation migrations, their
 * rollbacks and the captured live signup functions. The behaviour (golden
 * before/after signups, invariants, RPC counts, rollback rehearsal) is proven
 * by scripts/ci/sql-tests/run-tenant-foundation-test.sh, which this suite also
 * runs when a local PostgreSQL server binary is available.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIG = path.join(REPO, 'supabase/migrations');
const EV = path.join(REPO, 'docs/validation/VTID-05149');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const M1 = read(path.join(MIG, '20261014000100_vtid_05149_tenants_default_platform_flags.sql'));
const M2 = read(path.join(MIG, '20261014000200_vtid_05149_signup_default_tenant.sql'));
const M3 = read(path.join(MIG, '20261014000300_vtid_05149_ci_tenant_isolation_health.sql'));
const BEFORE = read(path.join(EV, 'functions-before.sql'));
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** The CREATE OR REPLACE FUNCTION statement for `name` (up to the closing $function$;). */
function fnStatement(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + '$function$;'.length);
}

describe('VTID-05149 tenant foundation migrations (static)', () => {
  it.each([
    ['M1', M1],
    ['M2', M2],
    ['M3', M3],
  ])('%s is one transaction with a lock timeout', (_n, sql) => {
    const body = stripComments(sql);
    expect(body).toMatch(/^BEGIN;/m);
    expect(body).toMatch(/^COMMIT;/m);
    expect(body).toContain("SET LOCAL lock_timeout = '3s';");
    expect(body).not.toMatch(/schema_migrations/);
  });

  it('M1: pre-guard, both columns, CHECK, partial unique index, deferred constraint trigger, maxina UPDATE last, self-check', () => {
    const body = stripComments(M1);
    expect(body).toContain("RAISE EXCEPTION 'VTID-05149 M1: tenants.is_default already exists");
    expect(body).toContain('expected exactly 2 tenants, one of them maxina');
    const order = [
      'ADD COLUMN is_default boolean NOT NULL DEFAULT false',
      'ADD CONSTRAINT tenants_default_not_platform CHECK (NOT (is_default AND is_platform))',
      'CREATE UNIQUE INDEX tenants_one_default ON public.tenants ((true)) WHERE is_default',
      'CREATE FUNCTION public.tenants_assert_one_default()',
      'CREATE CONSTRAINT TRIGGER tenants_exactly_one_default',
      "UPDATE public.tenants SET is_default = true WHERE slug = 'maxina'",
      'DO $check$',
    ].map((s) => body.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain('ADD COLUMN is_platform boolean NOT NULL DEFAULT false');
    expect(body).toMatch(/AFTER INSERT OR UPDATE OF is_default OR DELETE ON public\.tenants\s+DEFERRABLE INITIALLY DEFERRED/);
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_catalog/);
    expect(body).toContain('REVOKE ALL ON FUNCTION public.tenants_assert_one_default() FROM PUBLIC, anon, authenticated;');
  });

  it('M2: both md5 drift guards, the M1 prerequisite, no oldest-tenant fallback, post-guard', () => {
    expect(M2).toContain("md5(pg_get_functiondef('public.handle_new_user()'::regprocedure)) <> '9599cfbfa7d9f8532ea1564df99e430f'");
    expect(M2).toContain("md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure)) <> '6254e35b2765d8edd5976ec5b9eec4f3'");
    expect(M2).toContain('apply M1 (20261014000100) first');
    expect(M2).toContain('expected exactly one default tenant');
    expect(M2).not.toMatch(/ORDER BY t\.created_at/);
    expect(M2).toContain('still falls back to the oldest tenant');
    expect(M2).toMatch(/^-- definer-public: \S/m);
    expect(stripComments(M2)).not.toMatch(/\b(GRANT|REVOKE)\b/);
  });

  it('functions-before.sql reproduces the captured live md5s (pg_get_functiondef output + ";")', () => {
    for (const [name, md5] of [
      ['handle_new_user', '9599cfbfa7d9f8532ea1564df99e430f'],
      ['provision_platform_user', '6254e35b2765d8edd5976ec5b9eec4f3'],
    ]) {
      const def = fnStatement(BEFORE, name).replace(/;$/, '\n');
      expect(crypto.createHash('md5').update(def, 'utf8').digest('hex')).toBe(md5);
    }
  });

  it('M2 differs from the live bodies only in the slug filter, the default lookup and the no-tenant warning', () => {
    const added = new Set([
      'AND t.open_signup AND t.is_active AND NOT t.is_platform',
      'WHERE t.is_default',
      '',
      'IF v_tenant_id IS NULL THEN',
      "RAISE WARNING 'VTID-05149: no default tenant for %', NEW.id;",
      'RETURN NEW;',
      'END IF;',
      '-- Fallback: the default tenant (VTID-05149)',
    ]);
    const removed = new Set(['ORDER BY t.created_at ASC', '-- Fallback: oldest tenant']);
    for (const name of ['handle_new_user', 'provision_platform_user']) {
      const before = fnStatement(BEFORE, name).split('\n');
      const after = fnStatement(M2, name).split('\n');
      // Multiset line diff (bodies keep their own line endings; compare trimmed).
      const count = (lines: string[]) => {
        const m = new Map<string, number>();
        for (const l of lines) m.set(l.trim(), (m.get(l.trim()) ?? 0) + 1);
        return m;
      };
      const b = count(before);
      const a = count(after);
      for (const [line, n] of a) {
        const extra = n - (b.get(line) ?? 0);
        if (extra > 0) expect({ name, line, allowed: added.has(line) }).toEqual({ name, line, allowed: true });
      }
      for (const [line, n] of b) {
        const missing = n - (a.get(line) ?? 0);
        if (missing > 0) expect({ name, line, allowed: removed.has(line) }).toEqual({ name, line, allowed: true });
      }
      expect(fnStatement(M2, name)).toContain("RAISE WARNING 'VTID-05149: no default tenant for %', NEW.id;");
      expect(fnStatement(M2, name)).not.toMatch(/RAISE EXCEPTION/);
    }
  });

  it('M3: definer with pinned search_path, members revoked, service_role granted, counts only', () => {
    const body = stripComments(M3);
    expect(body).toMatch(/RETURNS json\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_catalog/);
    expect(body).toContain('REVOKE ALL ON FUNCTION public.ci_tenant_isolation_health() FROM PUBLIC, anon, authenticated;');
    expect(body).toContain('GRANT EXECUTE ON FUNCTION public.ci_tenant_isolation_health() TO service_role;');
    expect(body).toContain("c.column_name = 'tenant_id' AND c.data_type = 'uuid'");
    expect(body).toContain("c.table_name <> 'tenants'");
    expect(body).toContain('EXCEPTION WHEN OTHERS THEN');
    // Every dynamic scan selects aggregates only.
    const dynamic = body.match(/EXECUTE format\(\s*'select[\s\S]*?from public\.%I'/g) ?? [];
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].replace(/'\s+'/g, '').replace(/\s+/g, ' ')).toBe(
      "EXECUTE format( 'select count(*) filter (where tenant_id is not null and tenant_id not in (select tenant_id from public.tenants)), count(*) filter (where tenant_id is null) from public.%I'",
    );
    for (const key of [
      'generated_at', 'tables_scanned', 'text_tenant_id_tables', 'foreign_tenant_rows', 'foreign_tenant_tables',
      'null_tenant_rows', 'null_tenant_tables', 'users_zero_primary', 'users_multi_primary',
      'auth_users_without_membership', 'memberships_not_in_user_tenants', 'user_tenants_not_in_memberships',
      'default_tenant_count', 'platform_tenant_count', 'scan_errors',
    ]) {
      expect(body).toContain(`'${key}'`);
    }
    expect(body).toContain('LIMIT 25');
  });

  it('the rollbacks, pre-check and post-check files exist; R1 refuses to run before R2', () => {
    for (const f of ['rollback-m1.sql', 'rollback-m2.sql', 'rollback-m3.sql', 'live-before.sql', 'post-apply-checks.sql', 'functions-before.sql']) {
      expect(fs.existsSync(path.join(EV, f))).toBe(true);
    }
    expect(read(path.join(EV, 'rollback-m1.sql'))).toContain('apply rollback-m2.sql first');
    const r2 = read(path.join(EV, 'rollback-m2.sql'));
    for (const name of ['handle_new_user', 'provision_platform_user']) {
      expect(fnStatement(r2, name)).toBe(fnStatement(BEFORE, name));
    }
    expect(read(path.join(EV, 'rollback-m3.sql'))).toContain('DROP FUNCTION IF EXISTS public.ci_tenant_isolation_health();');
  });

  it('every migration is listed in docs/multitenancy/MIGRATION-QUEUE.md', () => {
    const queue = read(path.join(REPO, 'docs/multitenancy/MIGRATION-QUEUE.md'));
    for (const f of [
      '20261014000100_vtid_05149_tenants_default_platform_flags.sql',
      '20261014000200_vtid_05149_signup_default_tenant.sql',
      '20261014000300_vtid_05149_ci_tenant_isolation_health.sql',
    ]) {
      expect(queue).toContain(f);
    }
  });

  const pgBin = (() => {
    try {
      const dirs = fs.readdirSync('/usr/lib/postgresql').sort();
      const bin = `/usr/lib/postgresql/${dirs[dirs.length - 1]}/bin`;
      return fs.existsSync(`${bin}/initdb`) ? bin : null;
    } catch {
      return null;
    }
  })();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const canRunAsPostgres = !isRoot || spawnSync('id', ['postgres']).status === 0;
  (pgBin && canRunAsPostgres ? it : it.skip)('runs the SQL harness against a throwaway local cluster', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05149-pg-'));
    const asPg = isRoot ? ['runuser', '-u', 'postgres', '--'] : [];
    const sh = (cmd: string[]) => execFileSync(cmd[0], cmd.slice(1), { stdio: 'pipe', encoding: 'utf8' });
    if (isRoot) sh(['chown', 'postgres', work]);
    const port = '55451';
    try {
      sh([...asPg, `${pgBin}/initdb`, '-D', `${work}/data`, '-U', 'postgres', '-A', 'trust']);
      sh([...asPg, `${pgBin}/pg_ctl`, '-D', `${work}/data`, '-o', `-p ${port} -k ${work} -c listen_addresses=''`, '-l', `${work}/log`, '-w', 'start']);
      const out = execFileSync('bash', [path.join(REPO, 'scripts/ci/sql-tests/run-tenant-foundation-test.sh')], {
        env: { ...process.env, PGHOST: work, PGPORT: port, PGUSER: 'postgres' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: os.tmpdir(),
      });
      expect(out).toContain('PASS vtid-05149 tenant foundation');
    } finally {
      try {
        sh([...asPg, `${pgBin}/pg_ctl`, '-D', `${work}/data`, '-m', 'immediate', 'stop']);
      } catch {
        /* not started */
      }
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
