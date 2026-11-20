#!/usr/bin/env node
// VTID-05464 owner packet dry-run. In-process PGlite only: no network, no live or shared database, nothing applied.
//   node docs/validation/VTID-05464/owner-packet-outputs/dry-run.mjs > docs/validation/VTID-05464/owner-packet-outputs/dry-run.txt
// A: the replayed local stack (scripts/mt/stack) - both forward files, post-check.sql, the rollback, a re-apply.
// B: the lane fixture + the lane's committed pgTAP shim - the 36-assertion plan after apply, and after rollback + re-apply.
import { readFileSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createStack } from '../../../../scripts/mt/stack/stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const F1 = '20261102032000_vtid_05464_access_token_hook_shadow.sql';
const F2 = '20261102032100_vtid_05464_tenant_claim_mismatch_log.sql';
const RB = '20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql';
const mig = (f) => rd('supabase/migrations', f);
const first = (e) => String((e && e.message) || e).split('\n')[0];
let bad = 0;
const say = (s) => console.log(s);
async function step(db, label, sql, { expectError } = {}) {
  try { const r = await db.exec(sql); say(`PASS ${label}`); return r; }
  catch (e) { try { await db.exec('ROLLBACK'); } catch {} bad++; say(`FAIL ${label}: ${first(e)}`); return null; }
}
const state = async (db) => JSON.stringify((await db.query(`SELECT to_regprocedure('public.custom_access_token_hook_shadow(jsonb)') IS NOT NULL AS hook, to_regclass('public.tenant_claim_mismatch_log') IS NOT NULL AS log`)).rows[0]);
async function checks(db, label) {
  const res = await db.exec(rd('docs/validation/VTID-05464/post-check.sql'));
  say(`--- ${label}: post-check.sql: ${res.length} result sets`);
  res.forEach((r, i) => say(`  [${i}] ${(r.rows || []).length} row(s)${r.rows && r.rows[0] ? '; first: ' + JSON.stringify(r.rows[0]).slice(0, 330) : ''}`));
}
const SHIM = rd('docs/validation/VTID-05464/pglite/shim.sql');
const lane = (f) => rd(f).replace(/CREATE EXTENSION IF NOT EXISTS pgtap;/g, '-- pgtap: the shim is loaded instead');
function tap(res) {
  const byN = new Map();
  for (const r of res || []) for (const row of r.rows || []) {
    const v = Object.values(row)[0]; const m = typeof v === 'string' && v.match(/^(ok|not ok) (\d+) - /);
    if (m && !byN.has(+m[2])) byN.set(+m[2], v);
  }
  return [...byN.values()];
}

say('# VTID-05464 owner-packet dry-run. PGlite in process; nothing applied anywhere.');
say(`# node ${process.version}`);

say('\n## A. replayed local stack (supabase/migrations/*.sql replayed on PGlite, replay-skip.json honoured)');
{
  // The replay would apply the lane's own three files. Replay a copy of the directory without them so "before" is truly before.
  const src = join(ROOT, 'supabase/migrations');
  const tmp = mkdtempSync(join(tmpdir(), 'mig05464-'));
  for (const f of readdirSync(src, { withFileTypes: true })) if (f.isFile() && !f.name.includes('vtid_05464')) copyFileSync(join(src, f.name), join(tmp, f.name));
  const { db, report } = await createStack({ migrationsDir: tmp, fixtures: false, shim: false });
  say(`replay: ${report.replay.applied.length} applied, ${report.replay.skipped.length} skipped, ${report.replay.failed.length} failed`);
  say('idx_user_tenants_user present: ' + JSON.stringify((await db.query(`SELECT to_regclass('public.idx_user_tenants_user') IS NOT NULL AS present`)).rows[0]));
  say('supabase_auth_admin role present on the stack: ' + JSON.stringify((await db.query(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') AS present`)).rows[0]));
  say('state before: ' + await state(db));
  await db.exec(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF; END $r$`);
  say('harness added the supabase_auth_admin role (Supabase always has it; the stack does not)');
  await step(db, `apply ${F1}`, mig(F1));
  await step(db, `apply ${F2}`, mig(F2));
  say('state after both forward files: ' + await state(db));
  await checks(db, 'POST');
  await step(db, `re-apply ${F1} (idempotent)`, mig(F1));
  await step(db, `re-apply ${F2} (idempotent)`, mig(F2));
  await step(db, `apply rollback ${RB}`, mig(RB));
  say('state after rollback: ' + await state(db));
  await step(db, `rollback again (no-op)`, mig(RB));
  await step(db, `re-apply ${F1} after rollback`, mig(F1));
  await step(db, `re-apply ${F2} after rollback`, mig(F2));
  say('state after re-apply: ' + await state(db));
  await db.close();
}

say('\n## B. lane fixture + the lane pgTAP shim (36-assertion plan)');
{
  const db = new PGlite();
  await db.exec(SHIM);
  await step(db, 'fixture mt_identity_hook_fixture.sql', lane('supabase/tests/mt_identity_hook_fixture.sql'));
  await step(db, `apply ${F1}`, mig(F1));
  await step(db, `apply ${F2}`, mig(F2));
  let res = null;
  try { res = await db.exec(lane('supabase/tests/mt_identity_hook_shadow.test.sql')); } catch (e) { bad++; say('FAIL pgTAP plan: ' + first(e)); }
  let lines = tap(res); let nok = lines.filter((l) => l.startsWith('not ok')).length;
  say(`${lines.length === 36 && !nok ? 'PASS' : 'FAIL'} pgTAP mt_identity_hook_shadow.test.sql after apply: ${lines.length - nok} ok of ${lines.length}`); if (lines.length !== 36 || nok) bad++;
  await step(db, `apply rollback ${RB}`, mig(RB));
  say('state after rollback: ' + await state(db));
  await step(db, `re-apply ${F1}`, mig(F1));
  await step(db, `re-apply ${F2}`, mig(F2));
  try { res = await db.exec(lane('supabase/tests/mt_identity_hook_shadow.test.sql')); } catch (e) { bad++; say('FAIL pgTAP plan 2: ' + first(e)); }
  lines = tap(res); nok = lines.filter((l) => l.startsWith('not ok')).length;
  say(`${lines.length === 36 && !nok ? 'PASS' : 'FAIL'} pgTAP mt_identity_hook_shadow.test.sql after rollback + re-apply: ${lines.length - nok} ok of ${lines.length}`); if (lines.length !== 36 || nok) bad++;
  await db.close();
}
say(`\nRESULT: ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
