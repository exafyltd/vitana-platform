// VTID-05464: run the lane's SQL and pgTAP plan on PGlite (in-process Postgres, WASM). Throwaway, no network.
// usage: node run.mjs <lane-worktree> red|green
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const ROOT = process.argv[2];
const MODE = process.argv[3];
const SHIM = readFileSync(new URL('./shim.sql', import.meta.url), 'utf8');
const FIX = 'supabase/tests/mt_identity_hook_fixture.sql';
const TEST = 'supabase/tests/mt_identity_hook_shadow.test.sql';
const F1 = 'supabase/migrations/20261102032000_vtid_05464_access_token_hook_shadow.sql';
const RB1 = 'supabase/migrations/20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql';
const F2 = 'supabase/migrations/20261102032100_vtid_05464_tenant_claim_mismatch_log.sql';

const out = [];
const say = (s) => { console.log(s); out.push(s); };
const load = (f) => readFileSync(`${ROOT}/${f}`, 'utf8')
  .replace(/CREATE EXTENSION IF NOT EXISTS pgtap;/g, '-- pgtap is not in PGlite: the shim in shim.sql is loaded instead');

const db = new PGlite();
db.onNotice?.((n) => say(`  NOTICE: ${n.message}`));
await db.exec(SHIM);

async function step(label, file) {
  try {
    const res = await db.exec(load(file));
    say(`PASS ${label}  (${file.split('/').pop()})`);
    return res;
  } catch (e) {
    say(`FAIL ${label}  (${file.split('/').pop()}): ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

function tapLines(res) {
  // Each assertion comes back once from its own statement and again from finish(); keep one line per number.
  const byN = new Map();
  for (const r of res || []) for (const row of r.rows || []) {
    const v = Object.values(row)[0];
    const m = typeof v === 'string' && v.match(/^(ok|not ok) (\d+) - /);
    if (m && !byN.has(Number(m[2]))) byN.set(Number(m[2]), v);
  }
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

async function test(label) {
  const res = await step(label, TEST);
  const lines = tapLines(res);
  for (const l of lines) say('  ' + l);
  const oks = lines.filter((l) => l.startsWith('ok ')).length;
  say(`  ${oks} of ${lines.length} assertions ok`);
  return lines;
}

async function hookPresent() {
  const r = await db.query(`SELECT to_regprocedure('public.custom_access_token_hook_shadow(jsonb)') IS NOT NULL AS hook,
                                   to_regclass('public.tenant_claim_mismatch_log') IS NOT NULL AS log`);
  return r.rows[0];
}

await step('fixture (roles, user_tenants; pgtap line replaced by the shim)', FIX);

if (MODE === 'red') {
  say('RED A: the lane plan as written, on a database without the forward migrations (origin/main has none of them)');
  try {
    await db.exec(load(TEST));
    say('  the plan ran to the end (unexpected on origin/main)');
  } catch (e) {
    say('  plan stopped with an error before its first assertion: ' + e.message);
  }
  await db.query('ROLLBACK').catch(() => {});
  say('RED B: the first assertion (has_function, test line 36) with body checking off, so pg_temp.hook can be created');
  const head = load(TEST).split('\n').slice(0, 36).join('\n') + '\nSELECT * FROM finish();\nROLLBACK;\n';
  const res = await db.exec('SET check_function_bodies = off;\n' + head);
  const lines = tapLines(res);
  for (const l of lines) say('  ' + l);
  say(`  ${lines.filter((l) => l.startsWith('ok ')).length} of ${lines.length} assertions ok (plan 36)`);
} else {
  await step('forward 032000 (hook), apply 1', F1);
  await step('forward 032000 (hook), apply 2', F1);
  say(`state after forward 032000: ${JSON.stringify(await hookPresent())}`);
  await step('rollback 032000, in-order replay (expect NOTICE, no-op)', RB1);
  say(`state after in-order replay: ${JSON.stringify(await hookPresent())}`);
  await step('forward 032100 (mismatch log), apply 1', F2);
  await step('forward 032100 (mismatch log), apply 2', F2);
  say(`state after both forward files: ${JSON.stringify(await hookPresent())}`);
  const lines = await test('pgTAP plan 36, after both forward files');
  await step('rollback 032000 (drops hook and log), run 1', RB1);
  say(`state after rollback: ${JSON.stringify(await hookPresent())}`);
  await step('rollback 032000, run 2 (expect NOTICE, no-op)', RB1);
  say(`state after second rollback: ${JSON.stringify(await hookPresent())}`);
  await step('re-apply forward 032000', F1);
  await step('re-apply forward 032100', F2);
  say(`state after re-apply: ${JSON.stringify(await hookPresent())}`);
  const again = await test('pgTAP plan 36, after rollback and re-apply');
  say(`TOTAL green run: ${lines.filter((l) => l.startsWith('ok ')).length} of ${lines.length} on the first pass, ${again.filter((l) => l.startsWith('ok ')).length} of ${again.length} after rollback and re-apply (plan 36)`);
}

const { writeFileSync } = await import('node:fs');
writeFileSync(process.argv[4], out.join('\n') + '\n');
console.log(`\nwrote ${process.argv[4]}`);
