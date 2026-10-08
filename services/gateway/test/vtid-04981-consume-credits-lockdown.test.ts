/**
 * VTID-04981 — fn_consume_credits is callable by the gateway only.
 *
 * VTID-03107 granted it to `authenticated`; as SECURITY DEFINER with any
 * p_user_id and no auth.uid() check, that let a signed-in member debit another
 * member's earned VTNA or purchased credits. The lockdown migration revokes
 * it. This suite:
 *  - pins the migration (revoke + self-check),
 *  - fails the build if any LATER migration grants it to members again,
 *  - pins that the gateway calls it through the service-role client,
 *  - runs the SQL harness (scripts/ci/test-vtid-04981-…) when a local
 *    PostgreSQL server is available, as the VTID-04878 suite does.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const LOCKDOWN = '20261008170000_vtid_04981_consume_credits_lockdown.sql';
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, LOCKDOWN), 'utf8');

describe('VTID-04981 fn_consume_credits lockdown', () => {
  it('revokes members and keeps the gateway, and checks itself on apply', () => {
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;',
    );
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) TO service_role;',
    );
    expect(MIGRATION).toContain('fn_consume_credits must not be executable by members');
    // Access only: the function body is not redefined here.
    expect(MIGRATION).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
  });

  it('no later migration grants fn_consume_credits to members again', () => {
    const later = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > LOCKDOWN);
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      const grants = sql.match(/GRANT[^;]*fn_consume_credits[^;]*;/gi) ?? [];
      for (const g of grants) {
        expect({ file: f, grant: g }).toEqual({ file: f, grant: expect.not.stringMatching(/\b(authenticated|anon|PUBLIC)\b/i) });
      }
    }
  });

  it('the gateway calls it through the service-role client', () => {
    const repo = fs.readFileSync(path.join(REPO, 'services/gateway/src/services/entitlement-service-repository.ts'), 'utf8');
    expect(repo).toContain("sb.rpc('fn_consume_credits', params)");
    const svc = fs.readFileSync(path.join(REPO, 'services/gateway/src/services/entitlement-service.ts'), 'utf8');
    expect(svc).toMatch(/getSupabase\(\)|SUPABASE_SERVICE_ROLE/);
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
  (pgBin ? it : it.skip)('reproduces the VTID-03107 grant, applies the lockdown twice and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04981-consume-credits-lockdown.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55439' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04981: all assertions passed');
  }, 120_000);
});
