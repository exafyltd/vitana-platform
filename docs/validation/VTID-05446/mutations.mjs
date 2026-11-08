// VTID-05446: mutation check. Each mutation breaks one isolation property on the PGlite stack; the suite must go red.
//   node docs/validation/VTID-05446/mutations.mjs
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createStack, runTapFile } from '../../../scripts/mt/stack/stack.mjs';
import { HEALTH_TABLES } from '../../../scripts/mt/inventory/health-tables.mjs';

const root = resolve(import.meta.dirname, '../../..');
const spec = readFileSync(join(root, 'scripts/ci/sql-tests/mt-isolation.test.sql'), 'utf8');
const required = readFileSync(join(root, 'supabase/tests/local-stack/required-tables.txt'), 'utf8')
  .split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join(',');
const dir = mkdtempSync(join(tmpdir(), 'mt-mut-'));
const mutations = [
  ['baseline (no mutation)', '', 0, 0],
  ['community_groups: RLS disabled', 'ALTER TABLE public.community_groups DISABLE ROW LEVEL SECURITY;', 1, 0],
  ['services_catalog: select policy opened to all tenants', "DROP POLICY services_catalog_select ON public.services_catalog; CREATE POLICY services_catalog_select ON public.services_catalog FOR SELECT TO authenticated USING (true);", 1, 0],
  ['products_catalog: insert policy without tenant check', "DROP POLICY products_catalog_insert ON public.products_catalog; CREATE POLICY products_catalog_insert ON public.products_catalog FOR INSERT TO authenticated WITH CHECK (true);", 1, 0],
  ['health_features_daily: policy drops the user_id predicate', "DROP POLICY health_features_daily_select ON public.health_features_daily; CREATE POLICY health_features_daily_select ON public.health_features_daily FOR SELECT TO public USING (tenant_id = current_tenant_id());", 1, 0],
  ['user_tenants: select opened to all rows', "DROP POLICY user_tenants_select_own ON public.user_tenants; CREATE POLICY user_tenants_select_own ON public.user_tenants FOR SELECT TO authenticated USING (true);", 1, 0],
  ['strict mode: unverified tables fail', '', 1, 1],
];
let bad = false;
for (const [name, sql, wantFail, strict] of mutations) {
  const { db } = await createStack();
  if (sql) await db.exec(sql);
  const file = join(dir, 'm.tap.sql');
  writeFileSync(file, `SELECT set_config('mt.health_tables','${HEALTH_TABLES.join(',')}',false);\nSELECT set_config('mt.required_tables','${required}',false);\nSELECT set_config('mt.strict','${strict}',false);\n${spec}`);
  const r = await runTapFile(db, file);
  const red = !r.ok;
  const verdict = red === Boolean(wantFail) ? 'AS EXPECTED' : 'UNEXPECTED';
  if (verdict === 'UNEXPECTED') bad = true;
  console.log(`${verdict}: ${name} -> suite ${red ? 'RED' : 'GREEN'} (${r.run} run, ${r.failed} failed)`);
  for (const l of r.lines.filter((x) => x.startsWith('not ok')).slice(0, 3)) console.log(`    ${l}`);
  await db.close();
}
// runner-level mutations: flip the strict default back, or let the report mode print the PASS marker; --self-test-default must go red
const runner = join(root, 'scripts/ci/sql-tests/run-mt-isolation-test.sh');
const runnerMutations = [
  // the PASS-over-unverified guard in the runner is a second layer, so the revert removes both layers
  ['runner: default flipped back to STRICT=0 (and the unverified guard removed)', (t) => t.replace('STRICT=1   #', 'STRICT=0   #').replace('if [ "$UNVERIFIED" -gt 0 ]; then', 'if false; then')],
  ['runner: report mode prints the PASS marker', (t) => t.replace('echo "REPORT mt-isolation:', 'echo "PASS mt-isolation"; echo "REPORT mt-isolation:')],
];
for (const [name, edit] of runnerMutations) {
  const src = readFileSync(runner, 'utf8');
  const mutated = edit(src);
  if (mutated === src) { console.log(`UNEXPECTED: ${name} -> mutation did not apply`); bad = true; continue; }
  const tmp = join(root, 'scripts/ci/sql-tests/run-mt-isolation-test.mutant.sh');
  writeFileSync(tmp, mutated);
  const r = spawnSync('bash', [tmp, '--self-test-default'], { encoding: 'utf8' });
  unlinkSync(tmp);
  const red = r.status !== 0;
  if (!red) bad = true;
  console.log(`${red ? 'AS EXPECTED' : 'UNEXPECTED'}: ${name} -> self-test-default ${red ? 'RED' : 'GREEN'} (exit ${r.status}) ${(r.stderr || '').trim().split('\n').pop()}`);
}
process.exit(bad ? 1 : 0);
