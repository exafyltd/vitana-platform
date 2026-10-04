/**
 * VTID-04868 — Plan Sparring Gate, P1 database foundation (LOG MODE ONLY).
 *
 * Pins the migration's contract (and the hardening migration's: plan-hash
 * binding, collision-skipping 5-arg allocator, expected-round append) and,
 * when a local PostgreSQL server is available, applies both (twice) on top
 * of the current 3-arg allocator in a throwaway Postgres, runs the SQL assertions for log and enforce modes
 * (supabase/tests/vtid_04868_plan_sparring_gate.test.sql), then applies the
 * rollback (docs/validation/VTID-04868/rollback.sql) and re-applies.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql';
const MIGRATION = fs.readFileSync(path.join(REPO, MIGRATION_FILE), 'utf8');
const HARDENING_FILE = 'supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql';
const HARDENING = fs.readFileSync(path.join(REPO, HARDENING_FILE), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(REPO, 'docs/validation/VTID-04868/rollback.sql'), 'utf8');

/** SQL with comments removed, so prose can't satisfy an assertion. */
const code = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const SQL = code(MIGRATION);
const HSQL = code(HARDENING);

/** Body of one CREATE FUNCTION ... AS $$ ... $$ block. */
function fnBody(name: string, sql: string = SQL): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open + 2, close);
}

describe('VTID-04868 Plan Sparring Gate migration', () => {
  it('both migrations own their timestamps and sort in order after the prior allocator', () => {
    const files = fs.readdirSync(path.join(REPO, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('20261004110000_'))).toEqual([path.basename(MIGRATION_FILE)]);
    expect(files.filter((f) => f.startsWith('20261004120000_'))).toEqual([path.basename(HARDENING_FILE)]);
    expect(files.indexOf(path.basename(MIGRATION_FILE))).toBeGreaterThan(files.indexOf('20260628120000_fix_allocate_global_vtid_seq_drift.sql'));
    expect(files.indexOf(path.basename(HARDENING_FILE))).toBeGreaterThan(files.indexOf(path.basename(MIGRATION_FILE)));
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

  it('hardening: the 5-arg allocator restores the bounded collision-skipping loop and stores sparring_id + plan_hash', () => {
    const body = fnBody('allocate_global_vtid', HSQL);
    // The 20261004110000 allocator was plain nextval (409 on sequence drift);
    // the hardening migration restores the 20260628120000 free-slot loop.
    expect(body).toMatch(/FOR i IN 1\.\.1000 LOOP\s+v_num := nextval\('global_vtid_seq'\);/);
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM vtid_ledger WHERE vtid_ledger\.vtid = v_vtid\) THEN\s+v_found := true;\s+EXIT;/);
    expect(body).toMatch(/IF NOT v_found THEN\s+RAISE EXCEPTION[^;]*USING ERRCODE = 'unique_violation';/);
    expect(body).toContain("'Allocated - Pending Title'");
    expect(body).toContain("'allocator_version', 'VTID-0542'");
    expect(body).toMatch(/WHEN p_sparring_id IS NOT NULL\s+THEN jsonb_build_object\('sparring_id', p_sparring_id::TEXT\)/);
    expect(body).toMatch(/WHEN p_plan_hash IS NOT NULL\s+THEN jsonb_build_object\('plan_hash', p_plan_hash\)/);
    const sig = HSQL.slice(HSQL.indexOf('CREATE OR REPLACE FUNCTION public.allocate_global_vtid('), HSQL.indexOf('AS $$', HSQL.indexOf('CREATE OR REPLACE FUNCTION public.allocate_global_vtid(')));
    expect(sig).toMatch(/p_sparring_id UUID DEFAULT NULL,\s+p_plan_hash TEXT DEFAULT NULL\s*\)/);
    expect(sig).toContain('SECURITY DEFINER');
    expect(sig).toContain('SET search_path = public, pg_temp');
  });

  it('hardening: one transaction; 4-arg allocator and 2-arg append dropped before the new ones; service_role-only grants', () => {
    const begin = HSQL.indexOf('BEGIN;');
    const drop4 = HSQL.indexOf('DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text, uuid);');
    const create5 = HSQL.indexOf('CREATE OR REPLACE FUNCTION public.allocate_global_vtid(');
    const dropAppend = HSQL.indexOf('DROP FUNCTION IF EXISTS public.plan_sparring_append_round(uuid, jsonb);');
    const createAppend = HSQL.indexOf('CREATE OR REPLACE FUNCTION public.plan_sparring_append_round(');
    const commit = HSQL.lastIndexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(drop4);
    expect(drop4).toBeLessThan(create5);
    expect(dropAppend).toBeLessThan(createAppend);
    expect(createAppend).toBeLessThan(commit);
    expect(HSQL.slice(commit)).toMatch(/NOTIFY pgrst, 'reload schema';/);
    for (const sig of ['allocate_global_vtid(TEXT, TEXT, TEXT, UUID, TEXT)', 'plan_sparring_append_round(uuid, jsonb, int)']) {
      expect(HSQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(HSQL).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
    expect(HSQL).not.toMatch(/GRANT[^;]*\bTO\s+(anon|authenticated)\b/i);
    // Never touches the gate mode.
    expect(HSQL).not.toMatch(/plan_sparring_config/);
  });

  it('hardening: the gate binds only with the approved plan hash and still never raises', () => {
    const ev = fnBody('_plan_sparring_gate_eval', HSQL);
    expect(ev).toMatch(/v_hash\s+text\s+:= NULLIF\(btrim\(COALESCE\(p_metadata, '\{\}'::jsonb\)->>'plan_hash'\), ''\)/);
    expect(ev).toMatch(/ELSIF v_hash IS NULL THEN\s+v_reason := 'plan_hash_missing';\s+ELSIF v_hash <> v_s\.final_plan_hash THEN\s+v_reason := 'plan_hash_mismatch';/);
    // The hash check comes before the binding UPDATE.
    expect(ev.indexOf('plan_hash_mismatch')).toBeLessThan(ev.indexOf('UPDATE public.plan_sparring_sessions SET vtid = p_vtid'));
    expect(ev).not.toMatch(/RAISE/);
    expect(ev).toContain("(v_meta - 'sparring_id') || jsonb_build_object('sparring_id_unverified', v_raw)");
    expect(ev).toMatch(/FROM public\.plan_sparring_sessions WHERE id = v_sid FOR UPDATE/);
  });

  it('hardening: round appends are locked and checked against the expected round', () => {
    const ap = fnBody('plan_sparring_append_round', HSQL);
    expect(ap).toMatch(/FROM public\.plan_sparring_sessions WHERE id = p_session FOR UPDATE/);
    expect(ap).toMatch(/IF v_s\.verdict <> 'in_progress' THEN\s+RAISE EXCEPTION 'round_conflict:[^;]*USING ERRCODE = 'PS409';/);
    expect(ap).toMatch(/IF jsonb_array_length\(v_s\.rounds\) \+ 1 <> p_expected_round THEN\s+RAISE EXCEPTION 'round_conflict:[^;]*USING ERRCODE = 'PS409';/);
    expect(ap.indexOf('FOR UPDATE')).toBeLessThan(ap.indexOf('UPDATE public.plan_sparring_sessions'));
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
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text, uuid, text);');
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.plan_sparring_append_round(uuid, jsonb, int);');
    // The restored 3-arg body is the live pre-VTID-04868 one (plain nextval).
    expect(rb).toContain("v_num := nextval('global_vtid_seq');");
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
