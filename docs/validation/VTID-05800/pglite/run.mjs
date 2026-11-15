// VTID-05800 — local proof of migration 20261115090000 in PGlite (PostgreSQL in wasm). Never touches a live database.
//
//   node docs/validation/VTID-05800/pglite/run.mjs [--base]
//
// Loads the VTID-04868 fixture (the vtid_ledger shape the allocator writes), the real allocator migration and the three
// Plan Sparring Gate migrations as they are on main, then:
//   --base  stops there and shows what main does when the gate mode is flipped to enforce (the RED proof);
//   default applies 20261115090000 twice (idempotence) and checks that no mode of the gate can refuse an allocation,
//           then, on a second database, applies the rollback and re-applies the migration.
// PGLITE points at the PGlite package (default: /projects/sandbox/.tools/pglite, `npm i @electric-sql/pglite@0.3`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../../..');
const pkg = process.env.PGLITE || '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
const { PGlite } = await import(pathToFileURL(pkg).href);

const read = (p) => readFileSync(join(repo, p), 'utf8');
const BASE_FILES = [
  'supabase/tests/vtid_04868_fixture.sql',
  'supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql',
  'supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql',
  'supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql',
  'supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql',
];
const MIGRATION = 'supabase/migrations/20261115090000_vtid_05800_plan_sparring_gate_off.sql';
const ROLLBACK = 'docs/validation/VTID-05800/rollback-20261115090000.sql';

let failed = 0;
let n = 0;
function check(ok, what, detail = '') {
  n += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok' : 'not ok'} ${n} - ${what}${detail ? ` (${detail})` : ''}`);
}

async function fresh() {
  const db = new PGlite();
  for (const f of BASE_FILES) await db.exec(read(f));
  return db;
}
const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
async function allocate(db, sparringId = null) {
  try {
    const r = await one(db, 'select * from public.allocate_global_vtid($1, $2, $3, $4::uuid, $5)', ['cli', 'DEV', 'TASK', sparringId, null]);
    return { ok: true, vtid: r.vtid };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0] };
  }
}
const triggerCount = async (db) => Number((await one(db, "select count(*)::int as c from pg_trigger where tgname = 'trg_plan_sparring_check'")).c);
const indexExists = async (db) => (await one(db, "select to_regclass('public.vtid_ledger_sparring_id_unique') is not null as e")).e;
const mode = async (db) => (await one(db, 'select mode from public.plan_sparring_config where id = 1')).mode;
const setMode = (db, m) => db.query('update public.plan_sparring_config set mode = $1 where id = 1', [m]);
const SID = '6f1d1b4e-58a0-4c6e-9b1e-1f0c8f2b9a01';

if (process.argv.includes('--base')) {
  const db = await fresh();
  check((await triggerCount(db)) === 1, 'main: the sparring trigger is on vtid_ledger');
  await setMode(db, 'enforce');
  const r = await allocate(db);
  check(r.ok, 'main, gate mode enforce: an allocation without a sparring record succeeds', r.ok ? r.vtid : r.error);
  await setMode(db, 'log');
  const a = await allocate(db, SID);
  const b = await allocate(db, SID);
  check(a.ok && b.ok, 'main, log mode: two allocations may cite the same sparring id', `${a.vtid || a.error} / ${b.vtid || b.error}`);
} else {
  const db = await fresh();
  const before = (await db.query("select vtid, metadata from public.vtid_ledger where vtid in ('VTID-04800','VTID-04801','VTID-04802') order by vtid")).rows;
  await db.exec(read(MIGRATION));
  await db.exec(read(MIGRATION));
  check(true, 'the migration applies twice (idempotent)');
  check((await triggerCount(db)) === 0, 'the trigger trg_plan_sparring_check is gone');
  check(!(await indexExists(db)), 'the index vtid_ledger_sparring_id_unique is gone');
  check((await mode(db)) === 'off', "the gate mode is 'off'");
  const plain = await allocate(db);
  check(plain.ok, 'an allocation without a sparring record succeeds', plain.ok ? plain.vtid : plain.error);
  await setMode(db, 'enforce');
  const forced = await allocate(db);
  check(forced.ok, 'mode flipped back to enforce: an allocation without a sparring record still succeeds', forced.ok ? forced.vtid : forced.error);
  const a = await allocate(db, SID);
  const b = await allocate(db, SID);
  check(a.ok && b.ok, 'two allocations may cite the same sparring id', `${a.vtid || a.error} / ${b.vtid || b.error}`);
  const after = (await db.query("select vtid, metadata from public.vtid_ledger where vtid in ('VTID-04800','VTID-04801','VTID-04802') order by vtid")).rows;
  check(JSON.stringify(after) === JSON.stringify(before), 'existing ledger rows are untouched');

  const db2 = await fresh();
  await db2.exec(read(MIGRATION));
  await db2.exec(read(ROLLBACK));
  check((await triggerCount(db2)) === 1 && (await indexExists(db2)) && (await mode(db2)) === 'log', 'rollback: trigger, index and log mode are back');
  const logged = await allocate(db2);
  check(logged.ok, 'rollback: log mode never refuses an allocation', logged.ok ? logged.vtid : logged.error);
  await db2.exec(read(MIGRATION));
  check((await triggerCount(db2)) === 0 && (await mode(db2)) === 'off', 'the migration re-applies after the rollback');
}

console.log(`# ${n - failed}/${n} ok`);
process.exit(failed ? 1 : 0);
