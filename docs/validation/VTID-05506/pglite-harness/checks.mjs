// Usage: node checks.mjs <file.sql>...   Every file is executed in order; result sets are printed. Exit 1 on a SQL error.
// Schema auth and the roles come from supabase/tests/vtid_05150_fixture.sql; its pgcrypto extension is replaced by a shim.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
const db = new PGlite();
await db.exec(`CREATE FUNCTION public.gen_random_bytes(n int) RETURNS bytea LANGUAGE sql VOLATILE AS
  $$ SELECT decode(substr(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 1, n * 2), 'hex') $$;`);
for (const step of process.argv.slice(2)) {
  const name = step.split('/').pop();
  const text = readFileSync(step, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/gi, '');
  try {
    const res = await db.exec(text);
    const sets = res.filter((r) => r.fields && r.fields.length);
    console.log(`## ${name}${sets.length ? '' : ' (loaded)'}`);
    for (const r of sets) {
      console.log(r.fields.map((f) => f.name).join(' | '));
      for (const row of r.rows) console.log(Object.values(row).map((v) => (v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : v)).join(' | '));
      console.log('');
    }
  } catch (e) { console.log(`ERROR in ${name}: ${e.message}`); process.exit(1); }
}
