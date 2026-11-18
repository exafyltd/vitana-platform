// Local evidence: fixture -> live-before -> migrations -> post-apply -> (refused rollback) -> rollbacks -> rollback-check -> re-apply -> post-apply.
// PGlite only; every statement runs in a throwaway in-process database. Prints each check row; exit 1 on any ok=false or error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, '..'); const M = join(here, '../../../../supabase/migrations');
const rd = (f) => readFileSync(f, 'utf8');
const mig = readdirSync(M).filter((f) => /^2026110205(1000|1100)_vtid_05582_/.test(f)).sort().map((f) => join(M, f));
const db = new PGlite(); let bad = false;
await db.exec(`DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;`);
async function run(label, file, show) {
  try {
    const res = await db.exec(rd(file));
    console.log(`## ${label}`);
    if (show) for (const r of res) for (const row of r.rows ?? []) { console.log(JSON.stringify(row)); if (row.ok === false) bad = true; }
  } catch (e) { console.log(`## ${label}: ERROR ${e.message}`); bad = true; }
}
await run('fixture', join(V, 'pgtap/vtid_05582_fixture.sql'));
await run('live-before', join(V, 'live-before.sql'), true);
for (const f of mig) await run('apply ' + f.split('/').pop(), f);
await run('post-apply-checks', join(V, 'post-apply-checks.sql'), true);
// An opt-in exists: the profile rollback must refuse.
await db.exec(`UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = '05582000-0000-4000-8000-000000000001'`);
await run('rollback 051100', join(V, 'rollback-051100-connection-rpcs.sql'));
try { await db.exec(rd(join(V, 'rollback-051000-network-visible-profile.sql'))); console.log('## rollback 051000 with an opt-in: NOT REFUSED'); bad = true; }
catch (e) { console.log('## rollback 051000 with an opt-in is refused: ' + e.message.split('\n')[0]); await db.exec('ROLLBACK'); }
await db.exec(`UPDATE public.global_community_profiles SET network_visible = false WHERE user_id = '05582000-0000-4000-8000-000000000001'`);
await run('rollback 051000', join(V, 'rollback-051000-network-visible-profile.sql'));
await run('rollback-check', join(V, 'rollback-check.sql'), true);
for (const f of mig) await run('re-apply ' + f.split('/').pop(), f);
await run('post-apply-checks (after re-apply)', join(V, 'post-apply-checks.sql'), true);
process.exit(bad ? 1 : 0);
