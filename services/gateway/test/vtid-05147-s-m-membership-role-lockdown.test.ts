/**
 * VTID-05147 — Track S / S-M: members could escalate their own tenant role
 * and move their own membership.
 *
 * user_tenants_update_own (no WITH CHECK) let a member PATCH their own row to
 * active_role='admin' (requireTenantAdmin admitted on it) or to any
 * tenant_id; role_preferences / user_active_roles policies checked only the
 * user id, so the role value — read by the gateway as the effective role —
 * was free; set_role_preference accepted 'community' for any tenant and was
 * executable by anon. This suite:
 *  - pins the S-M migration (policy drops, revokes, set_role_preference
 *    membership check + ACL, lock_timeout, self-check),
 *  - fails the build if any LATER migration grants writes on the four tables
 *    to members again, recreates a dropped policy, or redefines
 *    set_role_preference without the membership check,
 *  - runs the SQL harness (scripts/ci/test-vtid-05147-…) when a local
 *    PostgreSQL server is available, as the VTID-05041 suite does.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const SM = '20261013233000_vtid_05147_s_m_membership_role_lockdown.sql';
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, SM), 'utf8');
const TABLES = ['user_tenants', 'role_preferences', 'user_active_roles', 'user_permitted_roles'];
const DROPPED_POLICIES = [
  'user_tenants_update_own',
  'rp_upsert_self',
  'rp_update_self',
  'rp_delete_self',
  'user_active_roles_insert',
  'user_active_roles_update',
];
const MEMBERSHIP_CHECK = /IF NOT is_exafy_admin AND NOT EXISTS \(\s*SELECT 1 FROM public\.user_tenants ut\s+WHERE ut\.user_id = auth\.uid\(\) AND ut\.tenant_id = p_tenant_id\s*\) THEN\s+RAISE EXCEPTION 'Not a member of this tenant' USING ERRCODE = '42501';/;

/** SQL without `--` comments, so prose in headers never satisfies or trips a check. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const sqlFiles = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

describe('VTID-05147 membership/role lockdown (S-M)', () => {
  const sql = stripComments(MIGRATION);

  it('is one transaction that never queues behind a long lock', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(MIGRATION).not.toMatch(/schema_migrations/);
  });

  it('drops the six member write policies and revokes member writes on the four tables', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS user_tenants_update_own ON public.user_tenants;');
    expect(sql).toContain('DROP POLICY IF EXISTS rp_upsert_self ON public.role_preferences;');
    expect(sql).toContain('DROP POLICY IF EXISTS rp_update_self ON public.role_preferences;');
    expect(sql).toContain('DROP POLICY IF EXISTS rp_delete_self ON public.role_preferences;');
    expect(sql).toContain('DROP POLICY IF EXISTS user_active_roles_insert ON public.user_active_roles;');
    expect(sql).toContain('DROP POLICY IF EXISTS user_active_roles_update ON public.user_active_roles;');
    for (const t of TABLES) {
      expect(sql).toContain(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.${t} FROM anon, authenticated;`,
      );
    }
    // Hygiene only: memberships / app_users keep their write policies and grants.
    expect(sql).toContain('REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.memberships FROM anon, authenticated;');
    expect(sql).toContain('REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.app_users FROM anon, authenticated;');
    expect(sql).not.toMatch(/DROP POLICY[^;]*(memberships|app_users)/i);
    // Reads stay.
    expect(sql).not.toMatch(/REVOKE[^;]*\bSELECT\b/i);
    expect(sql).not.toMatch(/DROP POLICY[^;]*(select|read)/i);
  });

  it('replaces set_role_preference with the membership check and closes PUBLIC/anon', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.set_role_preference(p_tenant_id uuid, p_role text)');
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/);
    expect(sql).toContain("IF auth.uid() IS NULL THEN\n    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';");
    expect(sql).toMatch(MEMBERSHIP_CHECK);
    // The membership check runs before anything is written.
    expect(sql.indexOf('Not a member of this tenant')).toBeLessThan(sql.indexOf('INSERT INTO public.role_preferences'));
    // Existing rules kept verbatim.
    expect(sql).toContain("RAISE EXCEPTION 'Role not granted for this tenant';");
    expect(sql).toContain("RAISE EXCEPTION 'Admin role can only be assigned by super administrators';");
    expect(sql).toContain('INSERT INTO public.user_active_roles (user_id, active_role, updated_at)');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.set_role_preference(uuid, text) FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.set_role_preference(uuid, text) TO authenticated, service_role;');
    // No other definer function is touched.
    expect(sql.match(/CREATE (OR REPLACE )?FUNCTION/gi)).toHaveLength(1);
  });

  it('checks the end state on apply, by effect', () => {
    expect(MIGRATION).toContain('DO $check$');
    expect(MIGRATION).toContain("has_table_privilege(r, t, p)");
    expect(MIGRATION).toContain("has_table_privilege('service_role', t, p)");
    expect(MIGRATION).toContain("cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')");
    expect(MIGRATION).toContain("has_function_privilege('anon', 'public.set_role_preference(uuid, text)', 'EXECUTE')");
    expect(MIGRATION).toContain("'public.me_set_active_role(text)', 'public.switch_to_tenant_by_slug(text)'");
  });

  it('no later migration gives members writes on the role/membership tables back', () => {
    const offenders: Array<{ file: string; why: string }> = [];
    for (const f of sqlFiles().filter((n) => n > SM)) {
      const body = stripComments(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      for (const g of body.match(/GRANT[^;]*;/gi) ?? []) {
        if (!/\bON\b/i.test(g) || /\bFUNCTION\b/i.test(g)) continue;
        const privs = g.replace(/\bON\b[\s\S]*$/i, '');
        const target = g.replace(/^[\s\S]*?\bON\b/i, '').replace(/\bTO\b[\s\S]*$/i, '');
        const grantees = g.replace(/^[\s\S]*?\bTO\b/i, '');
        const writes = /\b(INSERT|UPDATE|DELETE|ALL|TRUNCATE)\b/i.test(privs);
        const touches = TABLES.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(target)) || /ALL\s+TABLES\s+IN\s+SCHEMA/i.test(target);
        if (writes && touches && /\b(authenticated|anon|public)\b/i.test(grantees)) offenders.push({ file: f, why: g.trim() });
      }
      for (const p of DROPPED_POLICIES) {
        if (new RegExp(`CREATE\\s+POLICY\\s+"?${p}"?\\b`, 'i').test(body)) offenders.push({ file: f, why: `recreates ${p}` });
      }
      for (const t of TABLES) {
        const policies = body.match(new RegExp(`CREATE\\s+POLICY[^;]*\\bON\\s+(public\\.)?${t}\\b[^;]*;`, 'gi')) ?? [];
        for (const pol of policies) {
          const writes = /\bFOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i.test(pol) || !/\bFOR\s+SELECT\b/i.test(pol);
          const serviceOnly = /\bTO\s+service_role\b/i.test(pol);
          if (writes && !serviceOnly) offenders.push({ file: f, why: `client write policy on ${t}` });
        }
      }
      if (/FUNCTION\s+(public\.)?set_role_preference\s*\(/i.test(body) && /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?set_role_preference/i.test(body)) {
        if (!/Not a member of this tenant/.test(body)) offenders.push({ file: f, why: 'set_role_preference without the membership check' });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the evidence pack carries pre/post-apply checks and the rollback', () => {
    const dir = path.join(REPO, 'docs/validation/VTID-05147');
    for (const f of ['pre-apply-checks.sql', 'post-apply-checks.sql', 'rollback-s-m.sql']) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    // Pre/post checks are read-only.
    for (const f of ['pre-apply-checks.sql', 'post-apply-checks.sql']) {
      const body = stripComments(fs.readFileSync(path.join(dir, f), 'utf8')).replace(/'[^']*'/g, "''");
      expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|GRANT|REVOKE|CREATE|TRUNCATE)\b/i);
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
  (pgBin ? it : it.skip)('reproduces the live hole, applies twice and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-05147-s-m-lockdown.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55449' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('precondition: member forged active_role/role_preferences/user_active_roles before the migration');
    expect(out).toContain('migration applied twice (self-check passed both times)');
    expect(out).toContain('VTID-05147: all assertions passed');
  }, 120_000);
});
