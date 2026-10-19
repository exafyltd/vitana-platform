/**
 * VTID-05214 — policy approval of converged plans + Project Manager tables.
 *
 * Pins the migration's contract and, when a local PostgreSQL server is available, applies it (twice) on top of the
 * VTID-04868 gate in a throwaway Postgres, runs supabase/tests/vtid_05214_policy_approval.test.sql (log + enforce
 * mode, CHECK on non-converged, frozen rounds, PM lease), then the rollback and a re-apply.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const FILE = 'supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql';
const code = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const SQL = code(fs.readFileSync(path.join(REPO, FILE), 'utf8'));
const HARDENING = code(fs.readFileSync(path.join(REPO, 'supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql'), 'utf8'));
const ROLLBACK = fs.readFileSync(path.join(REPO, 'docs/validation/VTID-05214/rollback.sql'), 'utf8');

function fnBody(name: string, sql: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', start);
  return sql.slice(open + 2, sql.indexOf('$$', open + 2));
}

describe('VTID-05214 policy approval migration', () => {
  it('owns its timestamp and sorts after the VTID-04868 hardening migration', () => {
    const files = fs.readdirSync(path.join(REPO, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('20261015180000_'))).toEqual([path.basename(FILE)]);
    expect(files.indexOf(path.basename(FILE))).toBeGreaterThan(files.indexOf('20261004120000_vtid_04868_plan_sparring_hardening.sql'));
  });

  it('is one transaction and reloads the PostgREST schema', () => {
    expect(SQL.indexOf('BEGIN;')).toBeGreaterThan(-1);
    expect(SQL.lastIndexOf('COMMIT;')).toBeGreaterThan(SQL.indexOf('BEGIN;'));
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('a policy approval needs a converged session that asked for that policy (CHECK)', () => {
    expect(SQL).toMatch(/approval_policy IS NULL OR approval_policy IN \('converged-auto-v1'\)/);
    expect(SQL).toMatch(/policy_approved_at IS NULL\s+OR \(verdict = 'converged'\s+AND final_plan_hash IS NOT NULL\s+AND approval_policy IS NOT NULL\s+AND policy_approval_rule = approval_policy\)/);
  });

  it('the gate body differs from the hardening body only in the approval condition', () => {
    const before = fnBody('_plan_sparring_gate_eval', HARDENING);
    const after = fnBody('_plan_sparring_gate_eval', SQL);
    expect(after).toContain("v_s.policy_approved_at IS NOT NULL AND v_s.verdict = 'converged'");
    const norm = (s: string) => s.replace(/\s+/g, ' ');
    expect(norm(after).replace(/ELSIF v_s\.human_approved_by IS NULL AND NOT \(v_s\.policy_approved_at IS NOT NULL AND v_s\.verdict = 'converged'\) THEN/, 'ELSIF v_s.human_approved_by IS NULL THEN'))
      .toBe(norm(before));
  });

  it('round appends freeze on either approval', () => {
    expect(fnBody('plan_sparring_append_round', SQL)).toContain('v_s.human_approved_by IS NOT NULL OR v_s.policy_approved_at IS NOT NULL OR v_s.vtid IS NOT NULL');
  });

  it('PM tables: RLS on, service_role only, digests append-only', () => {
    expect(SQL).toMatch(/ALTER TABLE public\.pm_digests ENABLE ROW LEVEL SECURITY;/);
    expect(SQL).toMatch(/ALTER TABLE public\.pm_lease\s+ENABLE ROW LEVEL SECURITY;/);
    expect(SQL).toMatch(/REVOKE ALL ON public\.pm_digests FROM PUBLIC, anon, authenticated, service_role;/);
    expect(SQL).toMatch(/GRANT SELECT, INSERT ON public\.pm_digests TO service_role;/);
    expect(SQL).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*ON public\.pm_digests/);
  });

  it('the rollback restores the owner-only gate and drops the new objects', () => {
    expect(ROLLBACK).toContain("v_reason := 'not_human_approved';");
    expect(code(ROLLBACK)).not.toContain('policy_approved_at IS NOT NULL AND');
    expect(ROLLBACK).toContain('DROP TABLE IF EXISTS public.pm_lease;');
    expect(ROLLBACK).toContain('DROP COLUMN IF EXISTS policy_approved_at');
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
  (pgBin ? it : it.skip)('applies to a local Postgres replica and passes the log/enforce/rollback assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-05214-policy-approval.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55439' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-05214: all assertions passed');
    expect(out).toContain('VTID-05214: rollback + re-apply passed');
  }, 180_000);
});
