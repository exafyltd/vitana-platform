// Usage: node checks.mjs <step>...   step = path.sql (executed, result sets printed). Prints every result set; exits 1 on a SQL error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
const db = new PGlite();
await db.exec(`DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb DEFAULT '{}'::jsonb); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;`);
for (const step of process.argv.slice(2)) {
  const name = step.replace(/^extract:/, '').split('/').pop();
  let text = readFileSync(step.replace(/^extract:/, ''), 'utf8');
  if (step.startsWith('extract:')) text = /CREATE OR REPLACE FUNCTION public\.current_tenant_id\(\)[\s\S]*?\n\$\$;/.exec(text)[0];
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
