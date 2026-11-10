#!/usr/bin/env node
// VTID-05465 owner packet dry-run. In-process PGlite only: no network, no live or shared database, nothing applied.
//   node docs/validation/VTID-05465/owner-packet-outputs/dry-run.mjs > docs/validation/VTID-05465/owner-packet-outputs/dry-run.txt
// A: the replayed local stack (scripts/mt/stack) - helpers apply, the rewrite meets its live-body guard.
// B: the lane fixture (copies the 20260218 current_tenant_id() body) - helpers, rewrite, pgTAP, rollback, re-apply, guard on the old body.
import { readFileSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createStack, runTapFile, loadSkips, PATHS } from '../../../../scripts/mt/stack/stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = (f) => join(ROOT, 'supabase/migrations', f);
const T = (f) => join(ROOT, 'supabase/tests', f);
const V = (f) => join(ROOT, 'docs/validation/VTID-05465', f);
const HELPERS = '20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql';
const REWRITE = '20261102030100_vtid_05465_bare_policy_rewrite.sql';
const ROLLBACK = '20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql';
const sql = (p) => readFileSync(p, 'utf8');
const first = (e) => String((e && e.message) || e).split('\n')[0];
let bad = 0;
const say = (s) => console.log(s);
async function step(db, label, fn, { expectError } = {}) {
  const notices = [];
  try {
    const r = await fn();
    if (expectError) { say(`FAIL ${label}: expected a refusal, it applied`); bad++; return null; }
    say(`PASS ${label}`);
    return r;
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch {}
    const m = first(e);
    if (expectError && m.includes(expectError)) { say(`PASS ${label}: refused as expected: ${m}`); return null; }
    say(`FAIL ${label}: ${m}`); bad++; return null;
  }
}
// The stack shim (scripts/mt/stack/tap-shim.sql) has plan() but not no_plan(), which these pgTAP files call.
// Harness-only addition: no_plan() leaves the plan open and finish() then prints 1..<tests run>. Nothing in the repo changes.
const NO_PLAN = `CREATE OR REPLACE FUNCTION tap.no_plan() RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE tap.state SET n = 0, failed = 0, planned = NULL; RETURN '# no_plan'; END $$;
CREATE OR REPLACE FUNCTION tap.finish() RETURNS SETOF text LANGUAGE plpgsql AS $$ DECLARE t tap.state; BEGIN SELECT * INTO t FROM tap.state; RETURN NEXT '1..' || t.n; IF t.failed > 0 THEN RETURN NEXT '# Looks like you failed ' || t.failed || ' test(s) of ' || t.n; END IF; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tap TO PUBLIC;`;
const rows = async (db, q) => (await db.query(q)).rows;
async function runChecks(db, file, label) {
  // a read-only check file: run each statement, print the rows
  const text = sql(V(file));
  const res = await db.exec(text);
  say(`--- ${label}: ${file}: ${res.length} result sets`);
  res.forEach((r, i) => { if (r.rows && r.rows.length) say(`  [${i}] ${r.rows.length} row(s); first: ${JSON.stringify(r.rows[0]).slice(0, 400)}`); else say(`  [${i}] 0 rows`); });
}

say('# VTID-05465 owner-packet dry-run. PGlite in process; nothing applied anywhere.');
say(`# node ${process.version}`);

say('\n## A. replayed local stack (scripts/mt/stack: supabase/migrations/*.sql replayed, replay-skip.json honoured)');
{
  // Replay a copy of the directory without the lane's own files, so "before" is truly before.
  const tmp = mkdtempSync(join(tmpdir(), 'mig05465-'));
  for (const f of readdirSync(M(''), { withFileTypes: true })) if (f.isFile() && !f.name.includes('vtid_05465')) copyFileSync(M(f.name), join(tmp, f.name));
  const { db, report } = await createStack({ migrationsDir: tmp, skips: loadSkips().filter((s) => !s.file.includes('vtid_05465')), fixtures: false, shim: false });
  say(`replay: ${report.replay.applied.length} applied, ${report.replay.skipped.length} skipped, ${report.replay.failed.length} failed`);
  say(`replay-skip.json lists ${REWRITE}: ${loadSkips().some((s) => s.file === REWRITE)}`);
  say('helpers before: ' + JSON.stringify((await db.query(`SELECT to_regprocedure('public.tenant_id_for_policies()') IS NOT NULL AS tenant_id_for_policies, to_regprocedure('public.is_member(uuid)') IS NOT NULL AS is_member`)).rows[0]));
  await step(db, `apply ${HELPERS}`, () => db.exec(sql(M(HELPERS))));
  await step(db, `apply ${REWRITE} (the live current_tenant_id() here is not the 20260218 body)`, () => db.exec(sql(M(REWRITE))), { expectError: 'is not the 20260218 body' });
  say(JSON.stringify(await rows(db, `SELECT position('v_jwt_claims->''app_metadata''->>''active_tenant_id''' IN d) > 0 AS marker_1, position('FROM public.user_tenants' IN d) > 0 AS marker_2, position('WHERE user_id = auth.uid()' IN d) > 0 AS marker_3 FROM (SELECT pg_get_functiondef('public.current_tenant_id()'::regprocedure) AS d) x`)));
  say(JSON.stringify(await rows(db, `SELECT count(*) AS bare_policies_on_replayed_stack FROM pg_policies WHERE schemaname='public' AND coalesce(qual,'')||' '||coalesce(with_check,'') ~ 'current_tenant_id\\('`)));
  await db.close();
}

say('\n## B. lane fixture (20260218 body) on a fresh PGlite, lane harness order');
{
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto, pg_trgm } });
  await db.exec(sql(PATHS.tapShim)); await db.exec(NO_PLAN);
  await step(db, 'fixture mt_identity_helpers_fixture.sql', () => db.exec(sql(T('mt_identity_helpers_fixture.sql'))));
  await runChecks(db, 'pre-check.sql', 'PRE (before the helpers and the rewrite)');
  await step(db, `apply ${HELPERS}`, () => db.exec(sql(M(HELPERS))));
  await step(db, `apply ${REWRITE}`, () => db.exec(sql(M(REWRITE))));
  await step(db, `re-apply ${HELPERS} (idempotent)`, () => db.exec(sql(M(HELPERS))));
  await step(db, `re-apply ${REWRITE} (idempotent)`, () => db.exec(sql(M(REWRITE))));
  await runChecks(db, 'post-check.sql', 'POST (after both)');
  let r = await runTapFile(db, T('mt_identity_helpers_rls.test.sql'));
  say(`${r.ok ? 'PASS' : 'FAIL'} pgTAP mt_identity_helpers_rls.test.sql (after rewrite): ${r.run} run, ${r.failed} not ok, plan ${r.planned}`); if (!r.ok) { bad++; r.lines.filter((l) => !/^ok/.test(l)).slice(0, 8).forEach((l) => say('   ' + l)); }
  await step(db, `apply rollback ${ROLLBACK}`, () => db.exec(sql(M(ROLLBACK))));
  r = await runTapFile(db, T('mt_identity_helpers_rollback.test.sql'));
  say(`${r.ok ? 'PASS' : 'FAIL'} pgTAP mt_identity_helpers_rollback.test.sql (after rollback): ${r.run} run, ${r.failed} not ok`); if (!r.ok) { bad++; r.lines.filter((l) => !/^ok/.test(l)).slice(0, 8).forEach((l) => say('   ' + l)); }
  await step(db, 're-apply helpers after rollback', () => db.exec(sql(M(HELPERS))));
  await step(db, 're-apply rewrite after rollback', () => db.exec(sql(M(REWRITE))));
  r = await runTapFile(db, T('mt_identity_helpers_rls.test.sql'));
  say(`${r.ok ? 'PASS' : 'FAIL'} pgTAP mt_identity_helpers_rls.test.sql (after rollback + re-apply): ${r.run} run, ${r.failed} not ok`); if (!r.ok) bad++;
  await db.close();
}

say('\n## C. live-body guard: the rewrite on the OLD (20251229) current_tenant_id() body must refuse');
{
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto, pg_trgm } });
  await db.exec(sql(PATHS.tapShim)); await db.exec(NO_PLAN);
  await db.exec(sql(T('mt_identity_helpers_fixture.sql')));
  await db.exec(sql(T('mt_identity_helpers_live_body_guard_fixture.sql')));
  await db.exec(sql(M(HELPERS)));
  await step(db, `apply ${REWRITE} on the old body`, () => db.exec(sql(M(REWRITE))), { expectError: 'is not the 20260218 body' });
  const r = await runTapFile(db, T('mt_identity_helpers_live_body_guard.test.sql'));
  say(`${r.ok ? 'PASS' : 'FAIL'} pgTAP mt_identity_helpers_live_body_guard.test.sql: ${r.run} run, ${r.failed} not ok`); if (!r.ok) bad++;
  await db.close();
}
say(`\nRESULT: ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
