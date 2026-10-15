// VTID-05205 — applies migration 20261015150000_vtid_05205_welcome_team_claims.sql
// to a throwaway in-memory Postgres (PGlite) and checks the send-once claim
// RPCs. Never touches any real database.
// Run: node pglite-welcome-team-check.mjs <path-to-migration>
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';

const migration = readFileSync(process.argv[2], 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const U = '11111111-1111-4111-8111-111111111111';
const U2 = '44444444-4444-4444-8444-444444444444';
const T = '2e7528b8-472a-4356-88da-0280d4639cce';
const MSG = '99999999-9999-4999-8999-999999999999';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  INSERT INTO auth.users VALUES ('${U}'), ('${U2}');
`);

const claim = async (u = U, slug = 'mariia', t = T) =>
  (await db.query(`SELECT public.claim_welcome_message($1,$2,$3) AS r`, [u, t, slug])).rows[0].r;
const finish = async (st, u = U, slug = 'mariia', msg = MSG) =>
  (await db.query(`SELECT public.finish_welcome_message($1,$2,$3,$4) AS r`, [u, slug, st, msg])).rows[0].r;
const row = async (u = U, slug = 'mariia') =>
  (await db.query(`SELECT * FROM public.welcome_team_claims WHERE user_id=$1 AND sender_slug=$2`, [u, slug])).rows[0];

// 1. Applies, and applies twice.
await db.exec(migration);
check('migration applies', true);
try { await db.exec(migration); check('migration is re-runnable', true); }
catch (e) { check('migration is re-runnable', false, e.message); }

// 2. Send once: first claim wins, a second claim for the same pair does not.
let r = await claim();
check('first claim is granted (attempt 1)', r.ok === true && r.claimed === true && r.attempt === 1, JSON.stringify(r));
r = await claim();
check('a pending claim is never re-claimed (in_flight)', r.claimed === false && r.reason === 'in_flight', JSON.stringify(r));
r = await finish('sent');
check('finish(sent) moves the pending claim', r.ok === true, JSON.stringify(r));
const sentRow = await row();
check('sent row keeps the DM id and the send time', sentRow.status === 'sent' && sentRow.chat_message_id === MSG && sentRow.sent_at !== null);
r = await claim();
check('a sent welcome is never claimed again (already_sent)', r.claimed === false && r.reason === 'already_sent', JSON.stringify(r));
r = await finish('sent');
check('finish on a non-pending row is refused', r.ok === false && r.error === 'NOT_PENDING', JSON.stringify(r));

// 3. Other senders and other members are independent pairs.
r = await claim(U, 'jovana');
check('another sender for the same member is its own claim', r.claimed === true, JSON.stringify(r));
r = await claim(U2, 'mariia');
check('the same sender for another member is its own claim', r.claimed === true, JSON.stringify(r));

// 4. One retry after a failed send, then never again.
r = await claim(U, 'alex');
await finish('failed', U, 'alex', null);
r = await claim(U, 'alex');
check('a failed first attempt may be claimed once more (attempt 2)', r.claimed === true && r.attempt === 2, JSON.stringify(r));
await finish('failed', U, 'alex', null);
r = await claim(U, 'alex');
check('after a failed retry the pair is spent (retry_spent)', r.claimed === false && r.reason === 'retry_spent', JSON.stringify(r));
const failedRow = await row(U, 'alex');
check('failed row has no DM id', failedRow.status === 'failed' && failedRow.attempts === 2 && failedRow.chat_message_id === null);

// 5. Arguments are checked.
r = (await db.query(`SELECT public.claim_welcome_message($1,$2,$3) AS r`, [U, T, 'someone'])).rows[0].r;
check('an unknown sender is refused', r.ok === false && r.error === 'INVALID_SENDER', JSON.stringify(r));
r = (await db.query(`SELECT public.claim_welcome_message(NULL,$1,'mariia') AS r`, [T])).rows[0].r;
check('a missing member is refused', r.ok === false && r.error === 'ARGS_REQUIRED', JSON.stringify(r));
r = await finish('done', U2, 'mariia');
check('an unknown finish status is refused', r.ok === false && r.error === 'INVALID_STATUS', JSON.stringify(r));
try { await db.query(`INSERT INTO public.welcome_team_claims (user_id, sender_slug, tenant_id) VALUES ($1,'mariia',$2)`, [U, T]); check('the primary key blocks a second row for a pair', false); }
catch { check('the primary key blocks a second row for a pair', true); }

// 6. Locked down: RLS on, no policies, only service_role may execute.
const rls = (await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.welcome_team_claims'::regclass`)).rows[0];
check('RLS is enabled', rls.relrowsecurity === true);
const pol = (await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'welcome_team_claims'`)).rows[0];
check('no RLS policy exists (no client access)', pol.n === 0);
for (const fn of ['public.claim_welcome_message(uuid, uuid, text)', 'public.finish_welcome_message(uuid, text, text, uuid)']) {
  for (const role of ['anon', 'authenticated', 'public']) {
    const q = role === 'public'
      ? `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AND has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS ok`
      : `SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`;
    const ok = (await db.query(q)).rows[0].ok;
    check(`${role} cannot execute ${fn.split('(')[0]}`, ok === false);
  }
  const svc = (await db.query(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS ok`)).rows[0].ok;
  check(`service_role can execute ${fn.split('(')[0]}`, svc === true);
}
for (const role of ['anon', 'authenticated']) {
  const ok = (await db.query(`SELECT has_table_privilege('${role}', 'public.welcome_team_claims', 'SELECT') AS ok`)).rows[0].ok;
  check(`${role} has no SELECT on welcome_team_claims`, ok === false);
}

// 7. Deleting the member removes their claims (no orphan rows).
await db.query(`DELETE FROM auth.users WHERE id = $1`, [U2]);
const left = (await db.query(`SELECT count(*)::int AS n FROM public.welcome_team_claims WHERE user_id = $1`, [U2])).rows[0];
check('claims cascade with the member', left.n === 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
