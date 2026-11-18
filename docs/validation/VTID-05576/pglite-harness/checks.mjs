// Local evidence: fixture -> live-before -> migrations -> post-apply -> (refused rollbacks) -> rollbacks -> rollback-check -> re-apply -> post-apply.
// PGlite only; every statement runs in a throwaway in-process database. Prints each check row; exit 1 on any ok=false or error.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, '..'); const M = join(here, '../../../../supabase/migrations');
const rd = (f) => readFileSync(f, 'utf8');
const mig = readdirSync(M).filter((f) => /^2026110205(0000|0100|0200)_vtid_05576_/.test(f)).sort().map((f) => join(M, f));
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
await run('fixture', join(V, 'pgtap/vtid_05576_fixture.sql'));
await run('live-before', join(V, 'live-before.sql'), true);
for (const f of mig) await run('apply ' + f.split('/').pop(), f);
await run('post-apply-checks', join(V, 'post-apply-checks.sql'), true);
// A network message exists and the RPCs are still installed: the scope rollback must refuse.
await db.exec(`SET vitana.chat_send_rpc = 'on'; INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content, scope)
  VALUES ('05576000-0000-4000-8000-0000000000a1', '05576000-0000-4000-8000-000000000001', '05576000-0000-4000-8000-000000000003', 'n', 'network'); RESET vitana.chat_send_rpc;`);
await mustRefuse('rollback 050000 first (network message and RPCs present)', join(V, 'rollback-050000-chat-messages-scope.sql'));
await run('rollback 050200', join(V, 'rollback-050200-chat-messages-lockdown.sql'));
await run('rollback 050100', join(V, 'rollback-050100-send-message-rpcs.sql'));
await mustRefuse('rollback 050000 while a network message exists', join(V, 'rollback-050000-chat-messages-scope.sql'));
await db.exec(`DELETE FROM public.chat_messages WHERE scope = 'network'`);
await run('rollback 050000', join(V, 'rollback-050000-chat-messages-scope.sql'));
await run('rollback-check', join(V, 'rollback-check.sql'), true);
for (const f of mig) await run('re-apply ' + f.split('/').pop(), f);
await run('post-apply-checks (after re-apply)', join(V, 'post-apply-checks.sql'), true);
process.exit(bad ? 1 : 0);
