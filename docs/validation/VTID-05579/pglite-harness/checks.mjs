// Local evidence: fixture -> real 050000/051000 -> data -> live-before -> migrations -> post-apply -> (refused rollbacks) -> rollbacks ->
// rollback-check -> re-apply -> post-apply. PGlite only; every statement runs in a throwaway in-process database.
// Prints each check row; exit 1 on any ok=false or error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, '..'); const M = join(here, '../../../../supabase/migrations');
const rd = (f) => readFileSync(f, 'utf8');
const mig = readdirSync(M).filter((f) => /^2026110205(4000|4100|4200)_vtid_05579_/.test(f)).sort().map((f) => join(M, f));
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
async function mustRefuse(label, file) {
  try { await db.exec(rd(file)); console.log(`## ${label}: NOT REFUSED`); bad = true; }
  catch (e) { console.log(`## ${label} is refused: ${e.message.split('\n')[0]}`); try { await db.exec('ROLLBACK'); } catch {} }
}
await run('fixture', join(V, 'pgtap/vtid_05579_fixture.sql'));
await run('real 20261102050000 (VTID-05576)', join(M, '20261102050000_vtid_05576_chat_messages_scope.sql'));
await run('real 20261102051000 (VTID-05582)', join(M, '20261102051000_vtid_05582_network_visible_profile.sql'));
await run('fixture data', join(V, 'pgtap/vtid_05579_fixture_data.sql'));
await run('live-before', join(V, 'live-before.sql'), true);
for (const f of mig) await run('apply ' + f.split('/').pop(), f);
await run('post-apply-checks', join(V, 'post-apply-checks.sql'), true);
// A network group created by the function exists and the functions are installed.
const created = await db.query(`SELECT public.create_network_group_as('05579000-0000-4000-8000-000000000001', 'checks group') AS id`);
const gid = created.rows[0].id;
console.log(`## created network group ${gid} through create_network_group_as`);
await mustRefuse('rollback 054000 first (functions present)', join(V, 'rollback-054000-chat-groups-scope.sql'));
await run('rollback 054200', join(V, 'rollback-054200-chat-groups-rls.sql'));
await run('rollback 054100', join(V, 'rollback-054100-network-group-rpcs.sql'));
await mustRefuse('rollback 054000 while a function-created network group exists', join(V, 'rollback-054000-chat-groups-scope.sql'));
await db.exec(`SELECT set_config('vitana.chat_group_rpc', 'on', false); DELETE FROM public.chat_groups WHERE id = '${gid}'; SELECT set_config('vitana.chat_group_rpc', '', false);`);
await run('rollback 054000', join(V, 'rollback-054000-chat-groups-scope.sql'));
await run('rollback-check', join(V, 'rollback-check.sql'), true);
for (const f of mig) await run('re-apply ' + f.split('/').pop(), f);
await run('post-apply-checks (after re-apply)', join(V, 'post-apply-checks.sql'), true);
process.exit(bad ? 1 : 0);
