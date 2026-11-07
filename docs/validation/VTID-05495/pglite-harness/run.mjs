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
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sql') pre.push({ file: args[++i] });
  else if (args[i] === '--extract-fn') pre.push({ file: args[++i], extractFn: true });
  else test = args[i];
}
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
for (const { file: f, extractFn } of pre) {
  try {
    let text = readFileSync(f, 'utf8');
    if (extractFn) {
      // Take the REAL public.current_tenant_id() and its GRANTs out of the migration, unmodified.
      const m = /CREATE OR REPLACE FUNCTION public\.current_tenant_id\(\)[\s\S]*?\n\$\$;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.current_tenant_id\(\) TO authenticated;\s*\nGRANT EXECUTE ON FUNCTION public\.current_tenant_id\(\) TO service_role;/.exec(text);
      if (!m) throw new Error('current_tenant_id() not found in ' + f);
      text = m[0];
    }
    await db.exec(text); console.log(`# loaded ${f}${extractFn ? ' (current_tenant_id only)' : ''}`);
  }
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
