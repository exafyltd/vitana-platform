// VTID-04892 — applies migration 20261005130000_vtid_04892_onboarding_coach.sql
// to a throwaway in-memory Postgres (PGlite) with a minimal stand-in for the
// live tables it touches, and checks its behaviour. Never touches any real
// database. Run: node pglite-onboarding-coach-check.mjs <path-to-migration>
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';

const migration = readFileSync(process.argv[2], 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

async function base() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    -- user_proactive_touches as live (constraint text read 2026-10-05)
    CREATE TABLE public.user_proactive_touches (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, surface text NOT NULL,
      reason_tag text, sent_at timestamptz DEFAULT now(), metadata jsonb,
      CONSTRAINT user_proactive_touches_surface_check CHECK (surface = ANY (ARRAY['welcome_banner','priority_card','autopilot_badge','morning_brief','text_chat_awareness','self_awareness_preview','voice_opener']))
    );
    INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
    INSERT INTO public.user_proactive_touches (user_id, surface) VALUES
      ('11111111-1111-4111-8111-111111111111','priority_card'),
      ('11111111-1111-4111-8111-111111111111','welcome_banner');
  `);
  return db;
}

const U = '11111111-1111-4111-8111-111111111111';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const claim = async (db, day = '2026-10-20', key = 'first_diary', ch = 'push') =>
  (await db.query(`SELECT public.claim_onboarding_touch($1,$2,$3::date,$4,$5) AS r`, [U, T, day, key, ch])).rows[0].r;
const finish = async (db, id, st) =>
  (await db.query(`SELECT public.finish_onboarding_touch($1,$2) AS r`, [id, st])).rows[0].r;

// 1. Migration applies on top of live-shaped data, and applies twice.
const db = await base();
await db.exec(migration);
check('migration applies over existing pacer rows', true);
try { await db.exec(migration); check('migration is re-runnable', true); }
catch (e) { check('migration is re-runnable', false, e.message); }

// 2. Pacer CHECK: the code's surfaces are accepted, unknown ones rejected.
for (const s of ['did_you_know_card', 'voice_opener_tour', 'voice_opener_initiative', 'vitana_responsibility_message', 'onboarding_coach']) {
  try { await db.query(`INSERT INTO public.user_proactive_touches (user_id, surface) VALUES ($1,$2)`, [U, s]); check(`pacer accepts ${s}`, true); }
  catch (e) { check(`pacer accepts ${s}`, false, e.message); }
}
try { await db.query(`INSERT INTO public.user_proactive_touches (user_id, surface) VALUES ($1,'not_a_surface')`, [U]); check('pacer rejects an unknown surface', false); }
catch { check('pacer rejects an unknown surface', true); }
const cv = (await db.query(`SELECT convalidated FROM pg_constraint WHERE conname='user_proactive_touches_surface_check'`)).rows[0];
check('pacer constraint is validated', cv?.convalidated === true);

// 3. One touch per member per local day; one retry after a failed send.
let r = await claim(db);
check('first claim of the day succeeds', r.claimed === true && r.attempt === 1, JSON.stringify(r));
const id = r.id;
r = await claim(db);
check('second claim while pending is refused', r.claimed === false && r.reason === 'touch_in_flight', JSON.stringify(r));
check('finish(failed)', (await finish(db, id, 'failed')).ok === true);
r = await claim(db);
check('one retry after a failed send', r.claimed === true && r.attempt === 2, JSON.stringify(r));
check('finish(failed) again', (await finish(db, id, 'failed')).ok === true);
r = await claim(db);
check('no third attempt', r.claimed === false && r.reason === 'retry_spent', JSON.stringify(r));
r = await claim(db, '2026-10-21');
check('next local day has its own slot', r.claimed === true, JSON.stringify(r));
check('finish(sent)', (await finish(db, r.id, 'sent')).ok === true);
r = await claim(db, '2026-10-21');
check('after a sent touch the day is used', r.claimed === false && r.reason === 'already_touched_today', JSON.stringify(r));
check('finish on a non-pending row is refused', (await finish(db, r.id ?? id, 'sent')).ok === false);
check('bad channel rejected', (await claim(db, '2026-10-22', 'x', 'email')).error === 'INVALID_CHANNEL');

// 4. Grants: only service_role may claim; clients cannot write coach tables.
const grants = (await db.query(`
  SELECT p.proname,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
    FROM pg_proc p WHERE p.proname IN ('claim_onboarding_touch','finish_onboarding_touch')`)).rows;
for (const g of grants) check(`${g.proname}: service_role only`, !g.auth_exec && !g.anon_exec && g.svc_exec, JSON.stringify(g));
for (const t of ['onboarding_coach_state', 'onboarding_coach_decisions', 'onboarding_touch_ledger']) {
  const p = (await db.query(`SELECT has_table_privilege('authenticated','public.${t}','INSERT') i, has_table_privilege('authenticated','public.${t}','UPDATE') u`)).rows[0];
  check(`${t}: authenticated cannot write`, !p.i && !p.u, JSON.stringify(p));
}
const rls = (await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('onboarding_coach_state','onboarding_coach_decisions','onboarding_touch_ledger')`)).rows;
check('RLS on all three coach tables', rls.length === 3 && rls.every((x) => x.relrowsecurity), JSON.stringify(rls));

// 5. A surprising live surface fails the migration loudly and leaves nothing half-applied.
const db2 = await base();
await db2.exec(`ALTER TABLE public.user_proactive_touches DROP CONSTRAINT user_proactive_touches_surface_check;
                INSERT INTO public.user_proactive_touches (user_id, surface) VALUES ('${U}','legacy_surface');`);
let failed = false;
try { await db2.exec(migration); } catch { failed = true; await db2.exec('ROLLBACK'); }
const half = (await db2.query(`SELECT to_regclass('public.onboarding_coach_state') AS t`)).rows[0].t;
check('an unknown live surface aborts the whole migration', failed && half === null, `failed=${failed} table=${half}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
