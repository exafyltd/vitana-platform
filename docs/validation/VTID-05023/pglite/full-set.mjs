// VTID-05023 Aurora compatibility layer, checked in PGlite.
//   node full-set.mjs [--no-compat]  apply every supabase/migrations/*.sql in name order to an empty database
//                              (--no-compat leaves out the compat layer: control run; the held drop 20261102052300_vtid_05573_legacy_messages_drop.sql is excluded);
//                              prints one line per file and totals. Exit 1 if any file fails.
//   node full-set.mjs --rls    apply only the compat layer, then prove an RLS policy using auth.uid():
//                              rows with the session claim set, no rows without it. Exit 1 on mismatch.
// PGlite stands in for Aurora here. It has no Supabase roles or auth schema, so the compat layer must supply them.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { uuid_ossp } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/contrib/uuid_ossp.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const dir = join(root, 'supabase', 'migrations');
const COMPAT = '20251026235959_aurora_compat_layer.sql';
const HELD = '20261102052300_vtid_05573_legacy_messages_drop.sql';
const mode = process.argv.includes('--rls') ? 'rls' : 'full';
const noCompat = process.argv.includes('--no-compat'); // control run: same set, compat layer left out

const all = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
if (all[0] !== COMPAT) throw new Error(`compat layer is not first in apply order: first is ${all[0]}`);

const db = new PGlite({ extensions: { uuid_ossp } });
const firstLine = e => String(e?.message ?? e).split('\n')[0].slice(0, 200);

if (mode === 'rls') {
  await db.exec(readFileSync(join(dir, COMPAT), 'utf8'));
  console.log(`# applied ${COMPAT}`);
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  await db.exec(`
    CREATE TABLE public.vtid_05023_rls_probe (id int PRIMARY KEY, owner uuid NOT NULL);
    ALTER TABLE public.vtid_05023_rls_probe ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_only ON public.vtid_05023_rls_probe FOR SELECT TO authenticated USING (owner = auth.uid());
    GRANT SELECT ON public.vtid_05023_rls_probe TO authenticated;
    INSERT INTO public.vtid_05023_rls_probe VALUES (1, '${A}'), (2, '${B}'), (3, '${A}');
  `);
  const ids = async label => {
    const r = await db.query('SELECT id FROM public.vtid_05023_rls_probe ORDER BY id');
    const got = r.rows.map(x => x.id);
    console.log(`${label}: rows=[${got.join(',')}]`);
    return got;
  };
  let bad = 0;
  const expect = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? 'ok' : 'not ok'} - ${label} (want [${want.join(',')}])`);
    if (!ok) bad++;
  };
  await db.exec('SET ROLE authenticated');
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: A, role: 'authenticated' })]);
  console.log(`auth.uid() with claim sub=A: ${(await db.query('SELECT auth.uid()::text AS u')).rows[0].u}`);
  expect('claim set to user A returns A rows', await ids('claim=A'), [1, 3]);
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: B, role: 'authenticated' })]);
  expect('claim set to user B returns B rows', await ids('claim=B'), [2]);
  await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
  console.log(`auth.uid() with empty claim: ${(await db.query('SELECT auth.uid()::text AS u')).rows[0].u}`);
  expect('empty claim returns no rows', await ids('claim=empty'), []);
  await db.exec('RESET request.jwt.claims');
  console.log(`auth.uid() with claim unset: ${(await db.query('SELECT auth.uid()::text AS u')).rows[0].u}`);
  expect('claim unset returns no rows', await ids('claim=unset'), []);
  await db.exec('RESET ROLE');
  console.log(`# RLS probe: ${bad === 0 ? 'PASS' : 'FAIL'} (${4 - bad} ok, ${bad} not ok)`);
  process.exit(bad ? 1 : 0);
}

let pass = 0; const failed = [];
for (const f of all) {
  if (f === HELD) { console.log(`skip ${f} (held drop, excluded)`); continue; }
  if (noCompat && f === COMPAT) { console.log(`skip ${f} (control run without compat layer)`); continue; }
  try {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
    pass++;
    console.log(`ok   ${f}`);
  } catch (e) {
    failed.push(f);
    console.log(`FAIL ${f}: ${firstLine(e)}`);
    await db.exec('ROLLBACK').catch(() => {}); // a failed file leaves the session aborted; clear it so later files run
  }
}
const total = all.length - (all.includes(HELD) ? 1 : 0);
console.log(`# full set in order: ${total} files, pass ${pass}, fail ${failed.length}`);
process.exit(failed.length ? 1 : 0);
