// VTID-05467 (mt-identity-r2 / role-source-and-bootstrap): runs the lane's SQL on an in-memory Postgres (PGlite) over a
// stub schema (fixture-stub.sql). No database connection and no live system is used.
//
// What it proves, in order (each phase writes outputs/<file>.txt):
//   1. red on the base: the new pgTAP files fail on the previous bodies (pglite-red-base.txt);
//   2. the rollback is a no-op on a database without the lane, catalog fingerprint equal (pglite-rollback-noop.txt);
//   3. apply the forward files: the snapshot counts, and no selected role changes (pglite-apply.txt);
//   4. the pgTAP files pass after apply (pgtap-after-apply.txt);
//   5. rollback after a post-apply switch: the catalog fingerprint equals the base, the selected role of the switched
//      member is restored from the snapshot, the preference row is kept (pglite-rollback.txt);
//   6. re-apply and pgTAP again (pgtap-after-reapply.txt);
//   7. negative control: without the derivation trigger the single-source file fails (pglite-negative-control.txt);
//   8. the same files on the variant where tenants is keyed by id (pglite-variant-id.txt).
//
// Usage (scratch directory with @electric-sql/pglite installed):
//   cp <repo>/docs/validation/VTID-05467/pglite-check.mjs run.mjs && node run.mjs <repo>
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: node run.mjs <repo>');
  process.exit(2);
}
const outDir = path.join(repo, 'docs/validation/VTID-05467/outputs');
fs.mkdirSync(outDir, { recursive: true });
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const FIXTURE = read('docs/validation/VTID-05467/fixture-stub.sql');
const R1 = read('supabase/migrations/20261102033000_vtid_05467_single_role_source.sql');
const R2 = read('supabase/migrations/20261102033100_vtid_05467_fix_bootstrap_admin_user.sql');
const RB = read('supabase/migrations/20261102033000_vtid_05467_role_source_rollback.sql');
const T_SINGLE = read('supabase/tests/mt_identity_roles_single_source.test.sql');
const T_BOOT = read('supabase/tests/mt_identity_roles_bootstrap.test.sql');

// Minimal pgTAP stand-in: plan / ok / is / lives_ok / throws_ok / finish, with the real names and argument order.
const SHIM = `
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;

CREATE FUNCTION extensions.plan(n int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS __tap (i serial, ok boolean, d text);
  CREATE TEMP TABLE IF NOT EXISTS __plan (n int);
  TRUNCATE __tap RESTART IDENTITY;
  DELETE FROM __plan;
  INSERT INTO __plan VALUES (n);
  GRANT ALL ON __tap TO PUBLIC;
  GRANT ALL ON SEQUENCE __tap_i_seq TO PUBLIC;
  GRANT ALL ON __plan TO PUBLIC;
  RETURN '1..' || n;
END $$;

CREATE FUNCTION extensions.ok(b boolean, d text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE k int;
BEGIN
  INSERT INTO __tap (ok, d) VALUES (coalesce(b, false), coalesce(d, ''));
  SELECT max(i) INTO k FROM __tap;
  RETURN (CASE WHEN coalesce(b, false) THEN 'ok ' ELSE 'not ok ' END) || k::text || ' - ' || coalesce(d, '');
END $$;

CREATE FUNCTION extensions.is(have text, want text, d text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN extensions.ok(have IS NOT DISTINCT FROM want,
    coalesce(d, '') || CASE WHEN have IS DISTINCT FROM want
                            THEN ' [have ' || coalesce(have, 'NULL') || ', want ' || coalesce(want, 'NULL') || ']'
                            ELSE '' END);
END $$;

CREATE FUNCTION extensions.lives_ok(q text, d text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN extensions.ok(true, coalesce(d, ''));
EXCEPTION WHEN OTHERS THEN
  RETURN extensions.ok(false, coalesce(d, '') || ' [' || SQLSTATE || ': ' || SQLERRM || ']');
END $$;

CREATE FUNCTION extensions.throws_ok(q text, st text, m text, d text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN extensions.ok(false, coalesce(d, '') || ' [no error raised]');
EXCEPTION WHEN OTHERS THEN
  RETURN extensions.ok(SQLSTATE = st AND (m IS NULL OR SQLERRM = m),
    coalesce(d, '') || ' [' || SQLSTATE || ': ' || SQLERRM || ']');
END $$;

CREATE FUNCTION extensions.finish() RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_plan int; v_ran int; v_failed int;
BEGIN
  SELECT coalesce(max(n), 0) INTO v_plan FROM __plan;
  SELECT count(*)::int INTO v_ran FROM __tap;
  SELECT count(*)::int INTO v_failed FROM __tap WHERE NOT ok;
  RETURN 'SUMMARY planned=' || v_plan || ' ran=' || v_ran || ' failed=' || v_failed;
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO PUBLIC;
`;

const logs = {};
const log = (file, line) => {
  (logs[file] ||= []).push(line);
  console.log(line);
};
const flush = () => {
  for (const [file, lines] of Object.entries(logs)) {
    fs.writeFileSync(path.join(outDir, file), lines.join('\n') + '\n');
  }
};

let allPassed = true;
const check = (file, ok, label) => {
  log(file, `${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) allPassed = false;
};

async function newDb(tpk) {
  const db = new PGlite();
  await db.exec(FIXTURE.replaceAll('@TPK@', tpk));
  await db.exec(SHIM);
  return db;
}

// Catalog state that the rollback must restore exactly: bodies, ACLs, triggers, columns, privileges, snapshot tables.
async function fingerprint(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return JSON.stringify({
    functions: await q(`
      SELECT p.oid::regprocedure::text AS fn, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('set_role_preference', 'me_set_active_role', 'bootstrap_admin_user',
                           'user_tenants_derive_role_preference', 'check_role_permitted', 'current_tenant_id')
       ORDER BY 1`),
    triggers: await q(`
      SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgrelid = 'public.user_tenants'::regclass AND NOT tgisinternal ORDER BY 1`),
    legacy_tables: await q(`
      SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
       WHERE table_schema = 'legacy_archive' ORDER BY 1`),
    columns: await q(`
      SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('user_tenants', 'role_preferences', 'user_active_roles', 'user_permitted_roles')
       ORDER BY 1, 2`),
    privileges: await q(`
      SELECT t, r, p, has_table_privilege(r::name, t, p) AS granted
        FROM (VALUES ('public.user_tenants'), ('public.role_preferences'),
                     ('public.user_active_roles'), ('public.user_permitted_roles')) AS x(t),
             (VALUES ('anon'), ('authenticated'), ('service_role')) AS y(r),
             (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS z(p)
       ORDER BY 1, 2, 3`),
  });
}

// The member rows the lane must not change at apply time (value of the selected role and of the preference).
async function dataSnapshot(db) {
  return (await db.query(`
    SELECT ut.user_id::text AS user_id, ut.active_role AS selected, rp.role AS preference
      FROM public.user_tenants ut
      LEFT JOIN public.role_preferences rp ON rp.user_id = ut.user_id AND rp.tenant_id = ut.tenant_id
     ORDER BY 1`)).rows;
}

// Runs one pgTAP file in a transaction; its final ROLLBACK is replaced by the runner's own, so the TAP lines are read first.
async function runTap(db, sqlText) {
  let sql = sqlText.replace(/CREATE EXTENSION IF NOT EXISTS pgtap[^;]*;/, '');
  const at = sql.lastIndexOf('ROLLBACK;');
  if (at < 0) throw new Error('pgTAP file has no final ROLLBACK');
  sql = sql.slice(0, at);
  try {
    const results = await db.exec(sql);
    const lines = [];
    let summary = null;
    for (const r of results) {
      for (const row of r.rows || []) {
        for (const v of Object.values(row)) {
          if (typeof v !== 'string') continue;
          if (/^(not )?ok /.test(v)) lines.push(v);
          if (v.startsWith('SUMMARY ')) summary = v;
        }
      }
    }
    const tap = (await db.query('SELECT i, ok, d FROM __tap ORDER BY i')).rows;
    await db.exec('ROLLBACK');
    return { lines, summary, tap, error: null };
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => {});
    return { lines: [], summary: null, tap: [], error: e.message };
  }
}

// expectPass=false: a red run on purpose (the previous bodies). It is logged and does not affect the overall result.
function reportTap(file, title, res, expectPass = true) {
  log(file, `--- ${title}`);
  if (res.error) {
    log(file, `ERROR ${res.error}`);
    if (expectPass) check(file, false, `${title}: ran without error`);
    return false;
  }
  for (const l of res.lines) log(file, l);
  log(file, res.summary || 'SUMMARY missing');
  const m = /planned=(\d+) ran=(\d+) failed=(\d+)/.exec(res.summary || '');
  const ok = !!m && m[1] === m[2] && m[3] === '0';
  if (expectPass) {
    check(file, ok, `${title}: every planned assertion ran and passed`);
  } else {
    log(file, `(red run, expected to fail: ${ok ? 'it passed, which is unexpected' : 'it fails'})`);
  }
  return ok;
}

async function main() {
  // Phase 1: red on the base (the previous bodies, no derivation trigger, no snapshot).
  {
    const file = 'pglite-red-base.txt';
    const db = await newDb('tenant_id');
    log(file, 'Phase 1: the new pgTAP files on the base (previous bodies). Failures here are the expected red run.');
    reportTap(file, 'R1 single_source on base', await runTap(db, T_SINGLE), false);
    reportTap(file, 'R2 bootstrap on base', await runTap(db, T_BOOT), false);
    await db.close();
  }

  // Phase 2: rollback on the base is a no-op.
  {
    const file = 'pglite-rollback-noop.txt';
    const db = await newDb('tenant_id');
    const before = await fingerprint(db);
    await db.exec(RB);
    const after = await fingerprint(db);
    check(file, before === after,
      'rollback on a database without the lane leaves the catalog fingerprint identical (bodies, ACLs, triggers, columns, privileges)');
    await db.close();
  }

  // Phase 3-4: apply the forward files, check that no selected role changed, run the pgTAP files.
  const db = await newDb('tenant_id');
  const base = await fingerprint(db);
  {
    const file = 'pglite-apply.txt';
    const dataBefore = await dataSnapshot(db);
    await db.exec(R1);
    await db.exec(R2);
    const dataAfter = await dataSnapshot(db);
    log(file, `member rows before apply: ${JSON.stringify(dataBefore)}`);
    log(file, `member rows after apply:  ${JSON.stringify(dataAfter)}`);
    check(file, JSON.stringify(dataBefore) === JSON.stringify(dataAfter),
      'apply moves no data: every selected role and preference is unchanged (no backfill)');
    const snap = (await db.query(`
      SELECT (SELECT count(*)::int FROM "legacy_archive".bak_05467_user_tenants) AS ut,
             (SELECT count(*)::int FROM "legacy_archive".bak_05467_role_preferences) AS rp,
             (SELECT count(*)::int FROM "legacy_archive".bak_05467_user_active_roles) AS uar`)).rows[0];
    log(file, `snapshots: ${JSON.stringify(snap)}`);
    check(file, snap.ut === dataBefore.length && snap.rp === 2 && snap.uar === 1,
      'snapshot first: the three legacy_archive snapshots hold the rows of the apply');
    const trig = (await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.user_tenants'::regclass AND tgname = 'user_tenants_derive_role_preference' AND tgenabled <> 'D'`)).rows[0].n;
    check(file, trig === 1, 'the derivation trigger is installed and enabled');
  }
  {
    const file = 'pgtap-after-apply.txt';
    log(file, 'Phase 4: the pgTAP files after apply.');
    const a = reportTap(file, 'R1 single_source after apply', await runTap(db, T_SINGLE));
    const b = reportTap(file, 'R2 bootstrap after apply', await runTap(db, T_BOOT));
    check(file, !!a && !!b, 'both pgTAP files pass after apply');
  }

  // Phase 5: a post-apply switch, then the rollback. The switched member's selected role goes back to the snapshot value;
  // the preference row keeps the switch; the catalog equals the base.
  {
    const file = 'pglite-rollback.txt';
    await db.exec(`
      SELECT set_config('request.jwt.claims', json_build_object('sub', '05467000-0000-4000-8000-0000000000f2', 'role', 'authenticated', 'tenant_id', (SELECT coalesce(to_jsonb(t)->>'tenant_id', to_jsonb(t)->>'id') FROM public.tenants t WHERE t.is_default))::text, false);`);
    await db.exec(`SET ROLE authenticated; SELECT public.set_role_preference((SELECT coalesce(to_jsonb(t)->>'tenant_id', to_jsonb(t)->>'id')::uuid FROM public.tenants t WHERE t.is_default), 'developer'); RESET ROLE;`);
    const beforeRb = (await db.query(`
      SELECT (SELECT active_role FROM public.user_tenants WHERE user_id = '05467000-0000-4000-8000-0000000000f2') AS selected,
             (SELECT role FROM public.role_preferences WHERE user_id = '05467000-0000-4000-8000-0000000000f2') AS preference`)).rows[0];
    log(file, `before rollback, switched member: ${JSON.stringify(beforeRb)}`);
    await db.exec(RB);
    const afterRb = (await db.query(`
      SELECT (SELECT active_role FROM public.user_tenants WHERE user_id = '05467000-0000-4000-8000-0000000000f2') AS selected,
             (SELECT role FROM public.role_preferences WHERE user_id = '05467000-0000-4000-8000-0000000000f2') AS preference,
             (SELECT active_role FROM public.user_tenants WHERE user_id = '05467000-0000-4000-8000-0000000000f1') AS legacy_selected,
             (SELECT role FROM public.role_preferences WHERE user_id = '05467000-0000-4000-8000-0000000000f1') AS legacy_preference`)).rows[0];
    log(file, `after rollback:         ${JSON.stringify(afterRb)}`);
    check(file, afterRb.selected === 'community', 'rollback restores the apply-time selected role of the switched member');
    check(file, afterRb.preference === 'developer', 'rollback keeps the preference row the switch wrote');
    check(file, afterRb.legacy_selected === 'community' && afterRb.legacy_preference === 'professional',
      'rollback leaves the legacy disagreement exactly as it was at apply');
    const restored = await fingerprint(db);
    check(file, restored === base,
      'rollback restores the catalog exactly: previous bodies verbatim, ACLs, trigger and function removed, snapshots dropped');
  }

  // Phase 6: re-apply and run the pgTAP files again.
  {
    const file = 'pgtap-after-reapply.txt';
    await db.exec(R1);
    await db.exec(R2);
    log(file, 'Phase 6: re-apply after rollback, then the pgTAP files.');
    const a = reportTap(file, 'R1 single_source after re-apply', await runTap(db, T_SINGLE));
    const b = reportTap(file, 'R2 bootstrap after re-apply', await runTap(db, T_BOOT));
    check(file, !!a && !!b, 'both pgTAP files pass after re-apply');
  }
  await db.close();

  // Phase 7: negative control. Same apply, but the derivation trigger is dropped: the single-source file must fail.
  {
    const file = 'pglite-negative-control.txt';
    const neg = await newDb('tenant_id');
    await neg.exec(R1);
    await neg.exec('DROP TRIGGER user_tenants_derive_role_preference ON public.user_tenants;');
    log(file, 'Phase 7: negative control, derivation trigger dropped after apply. The file must NOT pass.');
    const res = await runTap(neg, T_SINGLE);
    const failed = res.tap.filter((r) => !r.ok).length;
    log(file, `${res.summary || res.error} ; failing assertions: ${failed}`);
    check(file, failed > 0, 'without the trigger the single-source file fails (the derivation is tested, not assumed)');
    await neg.close();
  }

  // Phase 8: variant where tenants is keyed by id (the 2025 bootstrap DDL). Red on base, then apply, then pass.
  {
    const file = 'pglite-variant-id.txt';
    const v = await newDb('id');
    log(file, 'Phase 8: tenants keyed by id. Red on base, then apply, then the pgTAP files.');
    reportTap(file, 'R2 bootstrap on base (id variant)', await runTap(v, T_BOOT), false);
    await v.exec(R1);
    await v.exec(R2);
    const a = reportTap(file, 'R1 single_source after apply (id variant)', await runTap(v, T_SINGLE));
    const b = reportTap(file, 'R2 bootstrap after apply (id variant)', await runTap(v, T_BOOT));
    check(file, !!a && !!b, 'both pgTAP files pass on the id variant');
    await v.close();
  }

  flush();
  const summary = allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED';
  log('pglite-summary.txt', summary);
  flush();
  console.log(summary);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error('runner crashed:', e);
  flush();
  process.exit(3);
});
