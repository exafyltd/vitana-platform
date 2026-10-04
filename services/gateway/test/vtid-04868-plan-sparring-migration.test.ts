/**
 * VTID-04868 — Plan Sparring Gate, P1 database foundation (LOG MODE ONLY).
 *
 * Pins the migration's contract and, when a local PostgreSQL server is
 * available, applies it (twice) on top of the current 3-arg allocator in a
 * throwaway Postgres, runs the SQL assertions for log and enforce modes
 * (supabase/tests/vtid_04868_plan_sparring_gate.test.sql), then applies the
 * rollback (docs/validation/VTID-04868/rollback.sql) and re-applies.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261004100000_vtid_04868_plan_sparring_gate.sql';
const MIGRATION = fs.readFileSync(path.join(REPO, MIGRATION_FILE), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(REPO, 'docs/validation/VTID-04868/rollback.sql'), 'utf8');

/** SQL with comments removed, so prose can't satisfy an assertion. */
const code = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const SQL = code(MIGRATION);

/** Body of one CREATE FUNCTION ... AS $$ ... $$ block. */
function fnBody(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$', open + 2);
  return SQL.slice(open + 2, close);
}

describe('VTID-04868 Plan Sparring Gate migration', () => {
  it('is the only migration with this timestamp and sorts after every existing one', () => {
    const files = fs.readdirSync(path.join(REPO, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('20261004100000_'))).toEqual([path.basename(MIGRATION_FILE)]);
    expect(files.indexOf(path.basename(MIGRATION_FILE))).toBeGreaterThan(files.indexOf('20260628120000_fix_allocate_global_vtid_seq_drift.sql'));
  });

  it('drops the 3-arg allocator and creates the 4-arg one in one transaction', () => {
    const begin = SQL.indexOf('BEGIN;');
    const drop = SQL.indexOf('DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text);');
    const create = SQL.indexOf('CREATE OR REPLACE FUNCTION public.allocate_global_vtid(');
    const commit = SQL.lastIndexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(drop);
    expect(drop).toBeLessThan(create);
    expect(create).toBeLessThan(commit);
    expect(SQL).toMatch(/p_sparring_id UUID DEFAULT NULL\s*\)/);
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('keeps the allocator body (skip-forward loop, shell row) and stores sparring_id in metadata', () => {
    const body = fnBody('allocate_global_vtid');
    expect(body).toContain("FOR i IN 1..1000 LOOP");
    expect(body).toContain("'Allocated - Pending Title'");
    expect(body).toContain("'allocator_version', 'VTID-0542'");
    expect(body).toMatch(/WHEN p_sparring_id IS NOT NULL\s+THEN jsonb_build_object\('sparring_id', p_sparring_id::TEXT\)/);
  });

  it('grants the RPCs to service_role only', () => {
    for (const sig of [
      'allocate_global_vtid(TEXT, TEXT, TEXT, UUID)',
      'submit_plan_sparring_record(uuid, text, text, text, jsonb, text, text, jsonb, text[])',
      'plan_sparring_append_round(uuid, jsonb)',
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
    expect(SQL).not.toMatch(/GRANT[^;]*\bTO\s+(anon|authenticated)\b/i);
    expect(SQL).not.toMatch(/CREATE POLICY[^;]*\bTO\s+(anon|authenticated|public)\b/i);
  });

  it('seeds log mode, and never overwrites a mode on re-run', () => {
    expect(SQL).toMatch(/mode\s+text NOT NULL DEFAULT 'log' CHECK \(mode IN \('off', 'log', 'enforce'\)\)/);
    expect(SQL).toMatch(/INSERT INTO public\.plan_sparring_config \(id, mode\) VALUES \(1, 'log'\)\s+ON CONFLICT \(id\) DO NOTHING;/);
    expect(SQL).not.toMatch(/UPDATE public\.plan_sparring_config/);
  });

  it('only raises in enforce mode; the log branch only warns', () => {
    const check = fnBody('plan_sparring_check');
    const raises = [...check.matchAll(/RAISE\s*(EXCEPTION|WARNING|;)/g)].map((m) => m[1]);
    expect(raises).toEqual([';', 'WARNING', 'EXCEPTION']);
    expect(check).toMatch(/IF v_mode = 'enforce' THEN\s+RAISE;/);
    expect(check).toMatch(/IF v_res->>'mode' = 'enforce' AND NOT \(v_res->>'allow'\)::boolean THEN\s+RAISE EXCEPTION/);
    // The evaluator never raises at all.
    expect(fnBody('_plan_sparring_gate_eval')).not.toMatch(/RAISE/);
  });

  it('passes the upsert path, binds under FOR UPDATE, and checks the exempt role', () => {
    const ev = fnBody('_plan_sparring_gate_eval');
    expect(ev.indexOf('l.vtid = p_vtid')).toBeLessThan(ev.indexOf('_plan_sparring_mode()'));
    expect(ev).toMatch(/FROM public\.plan_sparring_sessions WHERE id = v_sid FOR UPDATE/);
    expect(ev).toMatch(/v_s\.verdict NOT IN \('converged', 'escalated'\)/);
    expect(ev).toContain("p_actor = 'vitana_governance_owner'");
    expect(SQL).toMatch(/CREATE TRIGGER trg_plan_sparring_check\s+BEFORE INSERT ON public\.vtid_ledger/);
    // The trigger runs as the inserting role, so current_user is real.
    const triggerFn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.plan_sparring_check('), SQL.indexOf('AS $$', SQL.indexOf('CREATE OR REPLACE FUNCTION public.plan_sparring_check(')));
    expect(triggerFn).not.toMatch(/SECURITY DEFINER/);
    expect(SQL).toContain('_plan_sparring_gate_eval(NEW.vtid, NEW.metadata, current_user::text)');
  });

  it('attested records can never converge or carry an approval', () => {
    const sub = fnBody('submit_plan_sparring_record');
    expect(sub).toContain("'attested'");
    expect(sub).toContain("'pending_human_approval'");
    expect(sub).not.toContain("'converged'");
    const sigStart = SQL.indexOf('CREATE OR REPLACE FUNCTION public.submit_plan_sparring_record(');
    const sig = SQL.slice(sigStart, SQL.indexOf('RETURNS', sigStart));
    expect(sig).not.toMatch(/p_verdict|p_human_approved|p_trust_tier/);
  });

  it('keeps rounds append-only for service_role and the role NOLOGIN', () => {
    const updateGrant = SQL.match(/GRANT UPDATE \(([^)]*)\)\s+ON public\.plan_sparring_sessions TO service_role/);
    expect(updateGrant).not.toBeNull();
    expect(updateGrant![1]).not.toMatch(/\brounds\b/);
    const insertGrant = SQL.match(/GRANT INSERT \(([^)]*)\)\s+ON public\.plan_sparring_sessions TO service_role/);
    expect(insertGrant![1]).not.toMatch(/\brounds\b/);
    expect(SQL).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'vitana_governance_owner'\) THEN\s+CREATE ROLE vitana_governance_owner NOLOGIN/);
    expect(SQL).not.toMatch(/GRANT vitana_governance_owner TO/);
  });

  it('adds a partial unique index on the ledger sparring_id', () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS vtid_ledger_sparring_id_unique\s+ON public\.vtid_ledger \(\(metadata->>'sparring_id'\)\)\s+WHERE metadata->>'sparring_id' IS NOT NULL;/);
  });

  it('has a rollback that restores the 3-arg allocator', () => {
    const rb = code(ROLLBACK);
    expect(rb).toContain('DROP TRIGGER IF EXISTS trg_plan_sparring_check ON public.vtid_ledger;');
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text, uuid);');
    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.allocate_global_vtid\(\s+p_source TEXT DEFAULT 'api',\s+p_layer TEXT DEFAULT 'DEV',\s+p_module TEXT DEFAULT 'TASK'\s+\)/);
    expect(rb).toContain('GRANT EXECUTE ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT) TO service_role;');
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
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04868-plan-sparring.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55437' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04868: all assertions passed');
    expect(out).toContain('VTID-04868: rollback + re-apply passed');
  }, 180_000);
});
