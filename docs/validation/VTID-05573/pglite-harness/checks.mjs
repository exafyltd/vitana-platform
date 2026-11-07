// Local evidence: fixture -> deps -> live-before -> 052000 (freeze check) -> 052100 -> 052200 -> (refused drop) -> 052300 -> post-apply
// -> (refused rollback) -> rollbacks 052300, 052200, 052100, 052000 -> rollback-check -> re-apply all -> post-apply.
// PGlite only; every statement runs in a throwaway in-process database. Prints each check row; exit 1 on any ok=false or error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, '..'); const M = join(here, '../../../../supabase/migrations');
const rd = (f) => readFileSync(f, 'utf8');
const mig = (n) => join(M, n);
const L = ['20261102052000_vtid_05573_legacy_messages_snapshot_freeze.sql', '20261102052100_vtid_05573_legacy_messages_functions.sql',
  '20261102052200_vtid_05573_legacy_messages_migrate_run.sql', '20261102052300_vtid_05573_legacy_messages_drop.sql'].map(mig);
const db = new PGlite(); let bad = false;
await db.exec(`DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;`);
function show(res) { for (const r of res) for (const row of r.rows ?? []) { console.log(JSON.stringify(row)); if (row.ok === false) bad = true; } }
async function run(label, file, shown) {
  try { const res = await db.exec(rd(file)); console.log(`## ${label}`); if (shown) show(res); }
  catch (e) { console.log(`## ${label}: ERROR ${e.message}`); bad = true; }
}
async function sql(label, text) {
  try { const res = await db.exec(text); console.log(`## ${label}`); show(res); }
  catch (e) { console.log(`## ${label}: ERROR ${e.message}`); bad = true; }
}
async function refused(label, file) {
  try { await db.exec(rd(file)); console.log(`## ${label}: NOT REFUSED`); bad = true; }
  catch (e) { console.log(`## ${label} is refused: ${e.message.split('\n')[0]}`); try { await db.exec('ROLLBACK'); } catch {} }
}
await run('fixture', join(V, 'pgtap/vtid_05573_fixture.sql'));
await run('dep 050000', mig('20261102050000_vtid_05576_chat_messages_scope.sql'));
await run('dep 051000', mig('20261102051000_vtid_05582_network_visible_profile.sql'));
await run('live-before', join(V, 'live-before.sql'), true);

await run('apply 052000 (snapshot + freeze)', L[0]);
await sql('freeze: the four legacy tables take no write from any API role; reads still work', `
  SELECT 'frozen' AS check_name, NOT (has_table_privilege('service_role','public.messages','INSERT') OR has_table_privilege('service_role','public.global_messages','UPDATE')
     OR has_table_privilege('authenticated','public.messages','DELETE') OR has_table_privilege('anon','public.global_message_threads','TRUNCATE')
     OR has_table_privilege('service_role','public.message_threads','INSERT')) AS ok;
  SELECT 'participants_still_writable' AS check_name, has_table_privilege('service_role','public.thread_participants','INSERT') AS ok;
  SELECT 'snapshot_complete' AS check_name, (SELECT count(*) FROM public.bak_messages) = (SELECT count(*) FROM public.messages)
     AND (SELECT count(*) FROM public.bak_global_messages) = (SELECT count(*) FROM public.global_messages)
     AND (SELECT count(*) FROM public.bak_message_threads) = (SELECT count(*) FROM public.message_threads)
     AND (SELECT count(*) FROM public.bak_global_message_threads) = (SELECT count(*) FROM public.global_message_threads) AS ok;`);
await run('apply 052100 (functions)', L[1]);
await run('apply 052200 (migrate)', L[2]);
await sql('migrate run twice adds nothing', `SELECT 'idempotent' AS check_name, (SELECT count(*) FROM public.chat_messages) AS before_rerun;
  SELECT public.mt_legacy_messages_migrate() IS NOT NULL AS x;
  SELECT 'idempotent_after' AS check_name, (SELECT count(*) FROM public.chat_messages) = 14 AS ok;`);

// A row that cannot be placed must stop the drop.
await db.exec(`INSERT INTO public.bak_messages (id, tenant_id, body) VALUES ('05573000-0000-4000-8000-000000000f99', '05573000-0000-4000-8000-0000000000a1', 'unplaceable')`);
await refused('drop 052300 with an unplaceable legacy row', L[3]);
await sql('legacy tables still there after the refused drop', `SELECT 'still_there' AS check_name, to_regclass('public.messages') IS NOT NULL AND to_regclass('public.global_messages') IS NOT NULL AS ok;`);
await db.exec(`DELETE FROM public.bak_messages WHERE id = '05573000-0000-4000-8000-000000000f99'`);
// A migrated row that went missing must stop the drop as well.
await db.exec(`DELETE FROM public.chat_messages WHERE id = '05573000-0000-4000-8000-000000000f01'; SELECT set_config('x.y','z',false);`);
// (re-run of migrate inside the guard would re-insert it; so simulate a conflicting id with different marker instead)
await db.exec(`INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, content, scope) VALUES ('05573000-0000-4000-8000-000000000f01','05573000-0000-4000-8000-0000000000a1','05573000-0000-4000-8000-000000000008','05573000-0000-4000-8000-000000000001','squatter','community')`);
await refused('drop 052300 when a migrated id is occupied by a foreign row', L[3]);
await db.exec(`DELETE FROM public.chat_messages WHERE id = '05573000-0000-4000-8000-000000000f01'`);

await run('apply 052300 (drop)', L[3]);
await run('post-apply-checks', join(V, 'post-apply-checks.sql'), true);

// Rollback: a post-migration message in a migrated group refuses the row rollback.
await db.exec(`INSERT INTO public.chat_messages (tenant_id, sender_id, group_id, content, scope) VALUES ('05573000-0000-4000-8000-0000000000a1','05573000-0000-4000-8000-000000000001','05573000-0000-4000-8000-0000000000e2','new after migration','community')`);
await run('rollback 052300', join(V, 'rollback-052300-drop-legacy.sql'));
await refused('rollback 052200 while a migrated group has a new message', join(V, 'rollback-052200-migrated-rows.sql'));
await db.exec(`DELETE FROM public.chat_messages WHERE content = 'new after migration'`);
await run('rollback 052200', join(V, 'rollback-052200-migrated-rows.sql'));
await run('rollback 052100', join(V, 'rollback-052100-functions.sql'));
await run('rollback 052000', join(V, 'rollback-052000-snapshot-freeze.sql'));
await run('rollback-check', join(V, 'rollback-check.sql'), true);
await sql('pre-existing platform rows untouched by apply + rollback', `SELECT 'platform_rows_intact' AS check_name, (SELECT count(*) FROM public.chat_messages) = 2 AND (SELECT count(*) FROM public.chat_groups) = 1 AS ok;`);

// Re-apply from the restored state: the snapshot is kept, so it is not overwritten.
for (const f of L) await run('re-apply ' + f.split('/').pop(), f);
await run('post-apply-checks (after re-apply)', join(V, 'post-apply-checks.sql'), true);
process.exit(bad ? 1 : 0);
