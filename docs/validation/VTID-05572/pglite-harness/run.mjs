// Usage: node run.mjs [--sql file]... test.sql
// Loads PGlite, base supabase-like shim (roles, auth), the pgTAP shim, any --sql files in order, then runs the test.
// Prints TAP; exit 1 when any 'not ok', plan mismatch or SQL error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pre = []; let test;
for (let i = 0; i < args.length; i++) { if (args[i] === '--sql') pre.push(args[++i]); else test = args[i]; }
const db = new PGlite();
const base = `
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') $$;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;
`;
await db.exec(base);
await db.exec(readFileSync(join(here, 'shim.sql'), 'utf8'));
for (const f of pre) {
  try { await db.exec(readFileSync(f, 'utf8')); console.log(`# loaded ${f}`); }
  catch (e) { console.log(`# FAILED loading ${f}: ${e.message}`); process.exit(2); }
}
let sql = readFileSync(test, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgtap[^;]*;/gi, '');
let bad = false;
try {
  const res = await db.exec(sql);
  for (const r of res) for (const row of r.rows ?? []) {
    const v = Object.values(row)[0];
    if (typeof v === 'string' && /^(ok|not ok|1\.\.|#)/.test(v)) { console.log(v); if (/^not ok|^# Looks like/.test(v)) bad = true; }
  }
} catch (e) { console.log(`# SQL ERROR: ${e.message}`); bad = true; }
process.exit(bad ? 1 : 0);
