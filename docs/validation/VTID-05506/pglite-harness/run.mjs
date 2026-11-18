// Usage: node run.mjs [--sql file]... test.sql
// PGlite + pgTAP-compatible shim. Does NOT pre-create schema auth/roles: supabase/tests/vtid_05150_fixture.sql creates them.
// The fixture's `CREATE EXTENSION pgcrypto` is stripped and public.gen_random_bytes(int) is defined instead.
// Prints TAP; exit 1 on 'not ok', plan mismatch or SQL error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pre = []; let test;
for (let i = 0; i < args.length; i++) { if (args[i] === '--sql') pre.push(args[++i]); else test = args[i]; }
const db = new PGlite();
await db.exec(`CREATE FUNCTION public.gen_random_bytes(n int) RETURNS bytea LANGUAGE sql VOLATILE AS
  $$ SELECT decode(substr(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 1, n * 2), 'hex') $$;`);
await db.exec(readFileSync(join(here, 'shim.sql'), 'utf8'));
for (const f of pre) {
  try {
    const text = readFileSync(f, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/gi, '');
    await db.exec(text); console.log(`# loaded ${f}`);
  } catch (e) { console.log(`# FAILED loading ${f}: ${e.message}`); process.exit(2); }
}
const sql = readFileSync(test, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgtap[^;]*;/gi, '');
let bad = false;
try {
  const res = await db.exec(sql);
  for (const r of res) for (const row of r.rows ?? []) {
    const v = Object.values(row)[0];
    if (typeof v === 'string' && /^(ok|not ok|1\.\.|#)/.test(v)) { console.log(v); if (/^not ok|^# Looks like/.test(v)) bad = true; }
  }
} catch (e) { console.log(`# SQL ERROR: ${e.message}`); bad = true; }
process.exit(bad ? 1 : 0);
