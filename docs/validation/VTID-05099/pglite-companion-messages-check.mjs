// VTID-05099 — applies migration 20261012200000_vtid_05099_companion_messages.sql
// to a throwaway in-memory Postgres (PGlite) with a minimal stand-in for the
// live tables it touches, and checks its behaviour. Never touches any real
// database. Run: node pglite-companion-messages-check.mjs <path-to-migration>
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
    -- user_proactive_touches with the live CHECK (read from production 2026-10-12)
    CREATE TABLE public.user_proactive_touches (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, surface text NOT NULL,
      reason_tag text, sent_at timestamptz DEFAULT now(), metadata jsonb,
      CONSTRAINT user_proactive_touches_surface_check CHECK (surface = ANY (ARRAY['welcome_banner','priority_card','autopilot_badge','morning_brief','text_chat_awareness','self_awareness_preview','voice_opener','did_you_know_card','voice_opener_tour','voice_opener_initiative','vitana_responsibility_message','onboarding_coach']))
    );
    INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
    -- the live surfaces present in production (read 2026-10-12)
    INSERT INTO public.user_proactive_touches (user_id, surface) VALUES
      ('11111111-1111-4111-8111-111111111111','did_you_know_card'),
      ('11111111-1111-4111-8111-111111111111','priority_card'),
      ('11111111-1111-4111-8111-111111111111','voice_opener_initiative'),
      ('11111111-1111-4111-8111-111111111111','voice_opener_tour'),
      ('11111111-1111-4111-8111-111111111111','welcome_banner');
  `);
  return db;
}

const U = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const claim = async (db, { user = U, day = '2026-10-20', mode = 'live', sender = 'companion', key = 'vitana_index', card = 'F2' } = {}) =>
  (await db.query(`SELECT public.claim_companion_message($1,$2,$3::date,$4,$5,$6,$7,$8::jsonb) AS r`,
    [user, T, day, mode, sender, key, card, '{"total":512}'])).rows[0].r;
const finish = async (db, id, st, text = null, model = null) =>
  (await db.query(`SELECT public.finish_companion_message($1,$2,$3,$4,$5) AS r`, [id, st, text, model, null])).rows[0].r;

// 1. Migration applies on top of live-shaped data, and applies twice.
const db = await base();
await db.exec(migration);
check('migration applies over existing pacer rows', true);
try { await db.exec(migration); check('migration is re-runnable', true); }
catch (e) { check('migration is re-runnable', false, e.message); }

// 2. Pacer CHECK: every existing surface still accepted, the new one accepted, unknown rejected.
for (const s of ['welcome_banner', 'did_you_know_card', 'onboarding_coach', 'messenger_companion']) {
  try { await db.query(`INSERT INTO public.user_proactive_touches (user_id, surface) VALUES ($1,$2)`, [U, s]); check(`pacer accepts ${s}`, true); }
  catch (e) { check(`pacer accepts ${s}`, false, e.message); }
}
try { await db.query(`INSERT INTO public.user_proactive_touches (user_id, surface) VALUES ($1,'not_a_surface')`, [U]); check('pacer rejects an unknown surface', false); }
catch { check('pacer rejects an unknown surface', true); }
const cv = (await db.query(`SELECT convalidated FROM pg_constraint WHERE conname='user_proactive_touches_surface_check'`)).rows[0];
check('pacer constraint is validated', cv?.convalidated === true);

// 3. D1 — one real proactive DM per member per local day, across senders.
const c1 = await claim(db, { sender: 'proactive_match', key: 'new_match', card: 'F5' });
check('first real claim of the day succeeds', c1.claimed === true, JSON.stringify(c1));
const c2 = await claim(db, { sender: 'companion', key: 'vitana_index' });
check('second real claim same day (other sender) is refused', c2.claimed === false && c2.reason === 'already_sent_today', JSON.stringify(c2));
const c3 = await claim(db, { mode: 'staff', sender: 'companion' });
check('a staff-mode claim same day is refused too', c3.claimed === false, JSON.stringify(c3));
const c4 = await claim(db, { day: '2026-10-21' });
check('next local day is claimable again', c4.claimed === true, JSON.stringify(c4));
const c5 = await claim(db, { user: U2 });
check('another member is independent', c5.claimed === true, JSON.stringify(c5));

// 4. Shadow rows never block a real send, and are themselves once per day.
const s1 = await claim(db, { user: U2, day: '2026-10-22', mode: 'shadow' });
check('shadow claim succeeds', s1.claimed === true);
const s2 = await claim(db, { user: U2, day: '2026-10-22', mode: 'shadow' });
check('second shadow claim same day refused', s2.claimed === false && s2.reason === 'already_decided_today', JSON.stringify(s2));
const r1 = await claim(db, { user: U2, day: '2026-10-22', mode: 'live' });
check('real claim succeeds on a day that has a shadow row', r1.claimed === true, JSON.stringify(r1));

// 5. finish: only a pending row moves; status validated.
const f1 = await finish(db, s1.id, 'shadow', 'Guten Morgen…', 'eu.anthropic.claude-sonnet-4-6');
check('finish shadow row', f1.ok === true, JSON.stringify(f1));
const f2 = await finish(db, s1.id, 'sent');
check('finish twice is refused (not pending)', f2.ok === false && f2.error === 'NOT_PENDING');
const f3 = await finish(db, c1.id, 'bogus');
check('finish rejects an unknown status', f3.ok === false && f3.error === 'INVALID_STATUS');
await finish(db, c1.id, 'sent');
await finish(db, c4.id, 'sent');

// 6. Argument validation.
const bad = await claim(db, { mode: 'nope' });
check('claim rejects an unknown mode', bad.ok === false && bad.error === 'INVALID_MODE');
const bad2 = await claim(db, { sender: 'nope', day: '2026-10-30' });
check('claim rejects an unknown sender', bad2.ok === false && bad2.error === 'INVALID_SENDER');

// 7. mark_companion_replied marks the LATEST unreplied real send, never a shadow row.
const m1 = (await db.query(`SELECT public.mark_companion_replied($1) AS r`, [U])).rows[0].r;
check('reply marks a row', m1.marked === true);
const marked = (await db.query(`SELECT local_date::text AS d FROM public.companion_messages_ledger WHERE user_id=$1 AND replied_at IS NOT NULL`, [U])).rows;
check('the latest sent row was marked', marked.length === 1 && marked[0].d === '2026-10-21', JSON.stringify(marked));
const m2 = (await db.query(`SELECT public.mark_companion_replied($1) AS r`, [U2])).rows[0].r;
check('member with only shadow/pending rows: nothing marked', m2.marked === false);

// 8. Preferences defaults (owner D2): business off.
await db.query(`INSERT INTO public.companion_preferences (user_id) VALUES ($1)`, [U]);
const p = (await db.query(`SELECT enabled, topic_health, topic_community, topic_business FROM public.companion_preferences WHERE user_id=$1`, [U])).rows[0];
check('preference defaults: enabled, health+community on, business off',
  p.enabled === true && p.topic_health === true && p.topic_community === true && p.topic_business === false, JSON.stringify(p));

// 9. Grants: functions are service_role only; ledger not readable by clients.
for (const fn of ['claim_companion_message', 'finish_companion_message', 'mark_companion_replied']) {
  const g = (await db.query(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS a, has_function_privilege('service_role', p.oid, 'EXECUTE') AS s FROM pg_proc p WHERE proname=$1`, [fn])).rows[0];
  check(`${fn}: service_role only`, g.a === false && g.s === true, JSON.stringify(g));
}
const lg = (await db.query(`SELECT has_table_privilege('authenticated','public.companion_messages_ledger','SELECT') AS a`)).rows[0];
check('ledger not selectable by authenticated', lg.a === false);
const rls = (await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('companion_messages_ledger','companion_preferences') ORDER BY relname`)).rows;
check('RLS enabled on both tables', rls.length === 2 && rls.every((r) => r.relrowsecurity), JSON.stringify(rls));

// 10. A surprising live surface makes the migration fail loudly, nothing half-applied.
const db2 = await base();
await db2.exec(`ALTER TABLE public.user_proactive_touches DROP CONSTRAINT user_proactive_touches_surface_check;
  INSERT INTO public.user_proactive_touches (user_id, surface) VALUES ('${U}','surprise_surface');`);
let aborted = false;
try { await db2.exec(migration); } catch { aborted = true; await db2.exec('ROLLBACK'); }
const leftover = (await db2.query(`SELECT to_regclass('public.companion_messages_ledger') AS t`)).rows[0].t;
check('unknown live surface aborts the whole migration', aborted && leftover === null, `aborted=${aborted} leftover=${leftover}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
