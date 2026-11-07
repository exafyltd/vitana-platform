// Local evidence: fixture -> live-before -> migrations -> post-apply -> (refused rollbacks out of order) -> rollbacks -> rollback-check -> re-apply -> post-apply.
// PGlite only; every statement runs in a throwaway in-process database. Prints each check row; exit 1 on any ok=false or error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, '..'); const M = join(here, '../../../../supabase/migrations');
const rd = (f) => readFileSync(f, 'utf8');
const mig = readdirSync(M).filter((f) => /^20261102053(000|100|200)_vtid_05575_/.test(f)).sort().map((f) => join(M, f));
const db = new PGlite(); let bad = false;
await db.exec(`DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;`);
async function run(label, file, show) {
  try {
    const res = await db.exec(rd(file));
    console.log(`## ${label}`);
    if (show) for (const r of res) for (const row of r.rows ?? []) { console.log(JSON.stringify(row)); if (row.ok === false) bad = true; }
  } catch (e) { console.log(`## ${label}: ERROR ${e.message}`); bad = true; }
}
async function refused(label, file) {
  try { await db.exec(rd(file)); console.log(`## ${label}: NOT REFUSED`); bad = true; }
  catch (e) { console.log(`## ${label} is refused: ` + e.message.split('\n')[0]); try { await db.exec('ROLLBACK'); } catch {} }
}
const rb = (n) => join(V, readdirSync(V).find((f) => f.startsWith('rollback-' + n)));
// Fixture + the two dependencies (the real 05582 migration and the real 04888 matchers).
await run('fixture', join(V, 'pgtap/vtid_05575_fixture.sql'));
await run('dependency 20261102051000', join(M, '20261102051000_vtid_05582_network_visible_profile.sql'));
const t = rd(join(M, '20261005120000_vtid_04888_rule45_intents_profiles.sql'));
const defs = [...t.matchAll(/CREATE OR REPLACE FUNCTION public\.(search_intent_catalog_v2|compute_intent_matches_v2|search_intent_catalog|compute_intent_matches)\(.*?\$function\$;/gs)].map((x) => x[0]);
await db.exec(defs.join('\n').replace(/vector\(\d+\)/g, 'text').replace(/\(\w+(?:\.\w+)? <=> \w+\.\w+\)/g, '0.5'));
console.log('## matchers loaded (' + defs.length + ')');
await run('live-before', join(V, 'live-before.sql'), true);
for (const f of mig) await run('apply ' + f.split('/').pop(), f);
await run('post-apply-checks', join(V, 'post-apply-checks.sql'), true);
// Out-of-order rollbacks are refused.
await refused('rollback 053100 while the matchers are scoped', rb('053100'));
await refused('rollback 053000 while the guard exists', rb('053000'));
await run('rollback 053200', rb('053200'));
await run('rollback 053100', rb('053100'));
await run('rollback 053000', rb('053000'));
await run('rollback-check', join(V, 'rollback-check.sql'), true);
for (const f of mig) await run('re-apply ' + f.split('/').pop(), f);
await run('post-apply-checks (after re-apply)', join(V, 'post-apply-checks.sql'), true);
process.exit(bad ? 1 : 0);
