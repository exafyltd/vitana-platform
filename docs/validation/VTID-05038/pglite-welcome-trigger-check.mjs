// VTID-05038 — applies migration 20261010160000_vtid_05038_welcome_trigger_enrollment_restore.sql
// to a throwaway in-memory Postgres (PGlite) that carries the live VTID-03990
// function body and a minimal stand-in for the tables it touches, and checks
// its behaviour. Never touches any real database.
// Run: node pglite-welcome-trigger-check.mjs <vtid-03990-migration> <vtid-05038-migration>
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';

const old03990 = readFileSync(process.argv[2], 'utf8');
const migration = readFileSync(process.argv[3], 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // normal tenant
const BIG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // > 1000 members
const ALL = '0a000000-0000-4000-8000-000000000001'; // uncapped group in T
const F100 = '0a000000-0000-4000-8000-000000000002'; // capped (cap 2 here) group in T
const BIGALL = '0a000000-0000-4000-8000-000000000003'; // uncapped group in BIG
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOT = u(900), TESTER = u(901), REAL_MISSING = u(10), REAL_SENT = u(11);

async function base() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.user_tenants (user_id uuid, tenant_id uuid, is_primary boolean, created_at timestamptz DEFAULT now(), PRIMARY KEY (user_id, tenant_id));
    CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, display_name text, welcome_chat_sent boolean, vitana_id text);
    CREATE TABLE public.chat_groups (id uuid PRIMARY KEY, tenant_id uuid, name text, is_system boolean, metadata jsonb DEFAULT '{}');
    CREATE TABLE public.chat_group_members (group_id uuid, user_id uuid, tenant_id uuid, role text, UNIQUE (group_id, user_id));
    CREATE TABLE public.chat_messages (id bigserial PRIMARY KEY, tenant_id uuid, sender_id uuid, receiver_id uuid, content text, message_type text, metadata jsonb, sender_vitana_id text, receiver_vitana_id text);
    -- notification_test_actors is created by a vitana-v1 migration in the shared database.
    CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
  `);
  await db.exec(old03990); // creates service_bot_accounts (+2 real bot rows) and the VTID-03990 function
  await db.exec(`
    CREATE TRIGGER welcome_chat_on_primary_membership AFTER INSERT ON public.user_tenants
      FOR EACH ROW WHEN (NEW.is_primary = true) EXECUTE FUNCTION public.fire_welcome_chat_on_membership();
    INSERT INTO public.service_bot_accounts (user_id, label, reason) VALUES ('${BOT}', 'fixture-bot', 'fixture');
    INSERT INTO public.notification_test_actors VALUES ('${TESTER}');
    INSERT INTO public.chat_groups VALUES
      ('${ALL}', '${T}', 'Alle Beisammen', true, '{"cap": null}'),
      ('${F100}', '${T}', 'FIRST N', true, '{"cap": 2}'),
      ('${BIGALL}', '${BIG}', 'Alle (big)', true, '{"cap": null}');
  `);
  // T: 3 existing members (already in both groups → FIRST N is full at 2... cap 2, holds 2)
  for (const n of [1, 2, 3]) {
    await db.query(`INSERT INTO public.app_users VALUES ($1,$2,true,$3)`, [u(n), `M${n}`, `v${n}`]);
    await db.query(`INSERT INTO public.user_tenants (user_id, tenant_id, is_primary) VALUES ($1,$2,true)`, [u(n), T]);
  }
  // Members the reverted VTID-03990 body left out of the uncapped group, and
  // the accounts that must never be enrolled. Inserted with the trigger off
  // to reproduce the live state (missing membership) deterministically.
  await db.exec(`ALTER TABLE public.user_tenants DISABLE TRIGGER welcome_chat_on_primary_membership;`);
  for (const [id, sent] of [[REAL_MISSING, false], [REAL_SENT, true], [BOT, true], [TESTER, true]]) {
    await db.query(`INSERT INTO public.app_users VALUES ($1,'X',$2,'vx')`, [id, sent]);
    await db.query(`INSERT INTO public.user_tenants (user_id, tenant_id, is_primary) VALUES ($1,$2,true)`, [id, T]);
  }
  await db.exec(`ALTER TABLE public.user_tenants ENABLE TRIGGER welcome_chat_on_primary_membership;`);
  return db;
}

const member = async (db, g, id) =>
  (await db.query(`SELECT 1 FROM public.chat_group_members WHERE group_id=$1 AND user_id=$2`, [g, id])).rows.length === 1;
const count = async (db, sql, p = []) => Number((await db.query(sql, p)).rows[0].c);

// 1. Reproduce the regression on the VTID-03990 body: a member already marked
//    welcome_chat_sent is never enrolled.
{
  const db = await base();
  await db.query(`INSERT INTO public.app_users VALUES ($1,'Pre',true,'vp')`, [u(20)]);
  await db.query(`INSERT INTO public.user_tenants (user_id, tenant_id, is_primary) VALUES ($1,$2,true)`, [u(20), T]);
  check('regression reproduced on the VTID-03990 body (welcome_chat_sent member not enrolled)', !(await member(db, ALL, u(20))));
}

const db = await base();
const msgsBefore = await count(db, `SELECT count(*) c FROM public.chat_messages`);
await db.exec(migration);
check('migration applies on the VTID-03990 body', true);

// 2. Backfill: real members into the uncapped group only; never the bot/test account.
check('backfill enrolls the missing real member', await member(db, ALL, REAL_MISSING));
check('backfill enrolls a real member already marked welcome_chat_sent', await member(db, ALL, REAL_SENT));
check('backfill never enrolls a service bot', !(await member(db, ALL, BOT)));
check('backfill never enrolls a test actor', !(await member(db, ALL, TESTER)));
check('backfill does not touch the capped group', !(await member(db, F100, REAL_MISSING)) && !(await member(db, F100, REAL_SENT)));
check('backfill sends no chat message', (await count(db, `SELECT count(*) c FROM public.chat_messages`)) === msgsBefore);

// 3. New signups after the fix.
const signup = async (id, tenant, sent = false) => {
  await db.query(`INSERT INTO public.app_users VALUES ($1,'New',$2,'vn') ON CONFLICT DO NOTHING`, [id, sent]);
  await db.query(`INSERT INTO public.user_tenants (user_id, tenant_id, is_primary) VALUES ($1,$2,true)`, [id, tenant]);
};
await signup(u(30), T);
check('new member is enrolled in the uncapped group', await member(db, ALL, u(30)));
check('new member gets the unchanged welcome DM fan-out', (await count(db, `SELECT count(*) c FROM public.chat_messages WHERE sender_id=$1 AND content LIKE 'Hello! My name is New — I just joined%'`, [u(30)])) > 0);
const capCount = await count(db, `SELECT count(*) c FROM public.chat_group_members WHERE group_id=$1`, [F100]);
check('capped group respects its metadata cap', capCount <= 2, `members=${capCount}`);
await signup(u(31), T, true);
check('member already marked welcome_chat_sent is still enrolled', await member(db, ALL, u(31)));
await db.query(`INSERT INTO public.notification_test_actors VALUES ($1)`, [u(32)]);
await signup(u(32), T);
check('a registered test actor is not enrolled', !(await member(db, ALL, u(32))));
check('a registered test actor sends no welcome DM', (await count(db, `SELECT count(*) c FROM public.chat_messages WHERE sender_id=$1`, [u(32)])) === 0);
const sentFlag = (await db.query(`SELECT welcome_chat_sent FROM public.app_users WHERE user_id=$1`, [u(32)])).rows[0].welcome_chat_sent;
check('a registered test actor is marked welcome_chat_sent', sentFlag === true);

// 4. > 1000-member tenant: enrollment still happens, DM fan-out still skipped.
await db.exec(`ALTER TABLE public.user_tenants DISABLE TRIGGER welcome_chat_on_primary_membership;`);
await db.query(`INSERT INTO public.user_tenants (user_id, tenant_id, is_primary) SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, $1, true FROM generate_series(1, 1001) g`, [BIG]);
// The 1001 filler members already belong to the big tenant's group (they are not what this check is about).
await db.query(`INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role) SELECT $2, user_id, tenant_id, 'member' FROM public.user_tenants WHERE tenant_id=$1`, [BIG, BIGALL]);
await db.exec(`ALTER TABLE public.user_tenants ENABLE TRIGGER welcome_chat_on_primary_membership;`);
await signup(u(40), BIG);
check('> 1000-member tenant: new member enrolled', await member(db, BIGALL, u(40)));
check('> 1000-member tenant: no DM fan-out', (await count(db, `SELECT count(*) c FROM public.chat_messages WHERE sender_id=$1`, [u(40)])) === 0);

// 5. Re-running is a no-op.
const before = await count(db, `SELECT count(*) c FROM public.chat_group_members`);
try { await db.exec(migration); check('migration is re-runnable', true); }
catch (e) { check('migration is re-runnable', false, e.message); try { await db.exec('ROLLBACK'); } catch {} }
check('re-run adds nothing', (await count(db, `SELECT count(*) c FROM public.chat_group_members`)) === before);

// 6. A function changed since 2026-10-10 (neither VTID-03990 nor VTID-05038) aborts the whole migration.
{
  const d2 = await base();
  await d2.exec(`CREATE OR REPLACE FUNCTION public.fire_welcome_chat_on_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);
  let aborted = false;
  try { await d2.exec(migration); } catch (e) { aborted = /VTID-05038/.test(e.message); }
  try { await d2.exec('ROLLBACK'); } catch {}
  check('an unexpected live body aborts the migration', aborted);
  check('nothing was backfilled after the abort', !(await member(d2, ALL, REAL_MISSING)));
}

// 7. Too many missing memberships (> 200) aborts the whole migration.
{
  const d3 = await base();
  await d3.exec(`ALTER TABLE public.user_tenants DISABLE TRIGGER welcome_chat_on_primary_membership;`);
  await d3.query(`INSERT INTO public.user_tenants (user_id, tenant_id, is_primary) SELECT ('00000000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid, $1, true FROM generate_series(1, 201) g`, [T]);
  let aborted = false;
  try { await d3.exec(migration); } catch (e) { aborted = /> 200/.test(e.message); }
  try { await d3.exec('ROLLBACK'); } catch {}
  check('> 200 missing memberships aborts the migration', aborted);
  const src = (await d3.query(`SELECT prosrc FROM pg_proc WHERE proname='fire_welcome_chat_on_membership'`)).rows[0].prosrc;
  check('the function fix rolled back with it (one transaction)', !src.includes('VTID-05038'));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
