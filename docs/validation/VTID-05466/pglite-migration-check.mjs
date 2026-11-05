// VTID-05466 — membership-unification migrations, both pgTAP files (through a minimal pgTAP shim:
// plan/is/ok/lives_ok/throws_ok/finish) and the rollback, run end to end on an in-memory Postgres
// (PGlite, PostgreSQL 18) whose tables mirror the live columns and constraints that matter (from the
// migrations and the VTID-05043/05124/05147 read-only live notes). Proves the SQL logic, the replay
// order (rollback file sorts before the forward file), apply -> rollback -> re-apply -> rollback, and
// that the pgTAP files pass. It is not the local Supabase stack: the real side-effect trigger bodies are
// stubs here, and real pgTAP runs only under `supabase test db`.
//
//   mkdir <scratch> && cd <scratch> && echo '{"type":"module"}' > package.json && npm i @electric-sql/pglite
//   cp <repo>/docs/validation/VTID-05466/pglite-migration-check.mjs run.mjs
//   node run.mjs <repo>
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const repo = process.argv[2];
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const M1 = read('supabase/migrations/20261102031000_vtid_05466_user_tenants_canonical.sql');
const M2 = read('supabase/migrations/20261102031100_vtid_05466_memberships_view_dualwrite.sql');
const M3 = read('supabase/migrations/20261102031200_vtid_05466_membership_drift_report.sql');
const RB = read('supabase/migrations/20261102031000_vtid_05466_membership_unification_rollback.sql');
const T1 = read('supabase/tests/mt_identity_membership_backfill.test.sql');
const T2 = read('supabase/tests/mt_identity_membership_drift_report.test.sql');
const T3 = read('supabase/tests/mt_identity_membership_dualwrite.test.sql');

const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE SCHEMA auth; CREATE SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO PUBLIC;
CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb);
CREATE TYPE public.tenant_role AS ENUM ('community','patient','professional','reseller','staff','admin','backoffice','developer','infra');
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text UNIQUE);
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, email text UNIQUE NOT NULL, display_name text,
  welcome_chat_sent boolean NOT NULL DEFAULT false, live_room_id uuid);
CREATE TABLE public.memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'community', status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','inactive','pending')), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, tenant_id));
CREATE TABLE public.user_tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, user_id));
COMMENT ON TABLE public.user_tenants IS 'VTID-01101: M:N mapping of users to tenants with active_role per membership';
CREATE TABLE public.role_preferences (user_id uuid, tenant_id uuid, role text);
CREATE TABLE public.user_active_roles (user_id uuid PRIMARY KEY, active_role text);
CREATE TABLE public.user_permitted_roles (user_id uuid, tenant_id uuid, role text);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.user_tenants, public.role_preferences, public.user_active_roles, public.user_permitted_roles FROM anon, authenticated;
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY, label text NOT NULL, reason text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE public.chat_messages (id bigserial PRIMARY KEY, tenant_id uuid, sender_id uuid, receiver_id uuid, content text);
CREATE TABLE public.founding_members (user_id uuid PRIMARY KEY, tenant_id uuid);
CREATE TABLE public.autopilot_recommendations (id bigserial PRIMARY KEY, user_id uuid);
CREATE TABLE public.live_rooms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, host_user_id uuid);
CREATE FUNCTION public.membership_side_effects_suppressed() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('vitana.suppress_membership_side_effects', true), '') = 'on' $$;
CREATE FUNCTION public.fire_welcome_chat_on_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.user_id = '00000000-0000-0000-0000-000000000001' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = NEW.user_id) THEN RETURN NEW; END IF;
  IF (SELECT welcome_chat_sent FROM public.app_users WHERE user_id = NEW.user_id) THEN RETURN NEW; END IF;
  INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content)
  SELECT NEW.tenant_id, NEW.user_id, ut.user_id, 'hello' FROM public.user_tenants ut
   WHERE ut.tenant_id = NEW.tenant_id AND ut.user_id <> NEW.user_id;
  UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = NEW.user_id;
  RETURN NEW; END $$;
CREATE FUNCTION public.claim_founding_seat_on_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO public.founding_members VALUES (NEW.user_id, NEW.tenant_id) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE FUNCTION public.seed_onboarding_autopilot_on_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO public.autopilot_recommendations (user_id) VALUES (NEW.user_id); RETURN NEW; END $$;
CREATE FUNCTION public.create_user_live_room() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO public.live_rooms (tenant_id, host_user_id) VALUES (NEW.tenant_id, NEW.user_id); RETURN NEW; END $$;
CREATE TRIGGER welcome_chat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed()) EXECUTE FUNCTION public.fire_welcome_chat_on_membership();
CREATE TRIGGER founding_seat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed()) EXECUTE FUNCTION public.claim_founding_seat_on_membership();
CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed()) EXECUTE FUNCTION public.seed_onboarding_autopilot_on_membership();
CREATE TRIGGER trg_create_user_live_room AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed()) EXECUTE FUNCTION public.create_user_live_room();
-- live-like seed: one converged member, one drifted member (backfilled by M1), one orphan, bot, inactive.
INSERT INTO public.tenants (tenant_id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Maxina', 'maxina');
INSERT INTO public.app_users (user_id, email) VALUES
  ('22222222-0000-0000-0000-000000000001', 'm1@x'), ('22222222-0000-0000-0000-000000000002', 'm2@x'),
  ('00000000-0000-0000-0000-000000000001', 'bot@x');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000001', false);
INSERT INTO public.memberships (user_id, tenant_id, status) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'active'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'active'),
  ('33333333-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'active'),
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'active');
`;

// Minimal pgTAP: plan / is / ok / lives_ok / throws_ok / finish.
const PGTAP = `
CREATE FUNCTION extensions.plan(n int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN CREATE TEMP TABLE IF NOT EXISTS __tap (i serial, ok boolean, d text); GRANT ALL ON __tap TO PUBLIC;
  GRANT ALL ON SEQUENCE __tap_i_seq TO PUBLIC;
  CREATE TEMP TABLE IF NOT EXISTS __plan (n int); DELETE FROM __plan; INSERT INTO __plan VALUES (n); RETURN '1..' || n; END $$;
CREATE FUNCTION extensions.ok(b boolean, d text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN INSERT INTO __tap (ok, d) VALUES (coalesce(b, false), d); RETURN CASE WHEN b THEN 'ok ' ELSE 'not ok ' END || d; END $$;
CREATE FUNCTION extensions.is(a anyelement, b anyelement, d text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF a IS DISTINCT FROM b THEN RAISE NOTICE 'have % want %', a, b; END IF; RETURN extensions.ok(a IS NOT DISTINCT FROM b, d); END $$;
CREATE FUNCTION extensions.lives_ok(q text, d text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN RAISE NOTICE '%', SQLERRM; RETURN extensions.ok(false, d); END; RETURN extensions.ok(true, d); END $$;
CREATE FUNCTION extensions.throws_ok(q text, st text, m text, d text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE s text; BEGIN BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN extensions.ok(s = st, d); END; RETURN extensions.ok(false, d); END $$;
CREATE FUNCTION extensions.finish() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE n int; bad text; BEGIN SELECT count(*) INTO n FROM __tap;
  SELECT string_agg(d, ' | ') INTO bad FROM __tap WHERE NOT ok;
  IF n <> (SELECT __plan.n FROM __plan) THEN RAISE EXCEPTION 'planned % ran %', (SELECT __plan.n FROM __plan), n; END IF;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAILED: %', bad; END IF; RETURN NEXT 'all ' || n || ' passed'; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO PUBLIC;
`;

const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
const one = async (db, q) => (await db.query(q)).rows[0];
const tapFile = (s) => s.replace(/CREATE EXTENSION IF NOT EXISTS pgtap[^;]*;/, '').replace(/\nROLLBACK;\s*$/, '\nCOMMIT;');

async function runTests(db, label) {
  for (const [name, t] of [['backfill', T1], ['drift', T2], ['dualwrite', T3]]) {
    // Run the file but keep the transaction open to read results; its ROLLBACK becomes a savepoint-free run in a clone.
    const sql = t.replace(/CREATE EXTENSION IF NOT EXISTS pgtap[^;]*;/, '');
    try { await db.exec(sql); console.log(`ok   ${label}: pgTAP ${name} file passed (rolled back)`); }
    catch (e) { console.error(`FAIL ${label}: pgTAP ${name}:`, e.message); await db.exec('ROLLBACK').catch(() => {}); process.exit(1); }
    await db.exec('RESET ROLE; RESET search_path;');
  }
}

const db = new PGlite();
await db.exec(SCHEMA);
await db.exec(PGTAP);

const snap = async () => JSON.stringify([
  (await db.query(`SELECT tenant_id, user_id, active_role, is_primary FROM public.user_tenants ORDER BY user_id, tenant_id`)).rows,
  (await db.query(`SELECT user_id, welcome_chat_sent FROM public.app_users ORDER BY user_id`)).rows,
  (await one(db, `SELECT obj_description('public.user_tenants'::regclass, 'pg_class') AS c`)).c,
  (await db.query(`SELECT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','legacy_archive') ORDER BY 1`)).rows,
  (await db.query(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('public','legacy_archive') ORDER BY 1`)).rows,
]);
const before = await snap();

// Full replay order puts the rollback (…031000_membership_…) before the forward file (…031000_user_…).
await db.exec(RB);
assert((await snap()) === before, 'rollback on a database without the lane is a no-op (replay order)');

await db.exec(M1);
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = '22222222-0000-0000-0000-000000000002'`)).n === 1, 'M1 backfilled the drifted member');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = '00000000-0000-0000-0000-000000000001'`)).n === 0, 'M1 did not backfill the bot');
assert((await one(db, `SELECT (SELECT count(*) FROM chat_messages) + (SELECT count(*) FROM founding_members) + (SELECT count(*) FROM autopilot_recommendations) + (SELECT count(*) FROM live_rooms) AS n`)).n == 0, 'M1 fired no side effect');
assert((await one(db, `SELECT public.membership_side_effects_suppressed() s`)).s === false, 'suppression off after M1');
await db.exec(M2);
await db.exec(M3);
const r = (await one(db, `SELECT public.membership_drift_report() r`)).r;
console.log('     drift report after M1+M3:', JSON.stringify(r));
assert(r.memberships_not_in_user_tenants === 0, 'drift memberships -> user_tenants reads 0 after M1');
assert(r.drift === 0, 'drift reads 0 on the converged mirror');

await runTests(db, 'after apply');

await db.exec(RB);
assert((await snap()) === before, 'rollback restores the prior state exactly (rows, comment, functions, tables)');

await db.exec(M1); await db.exec(M2); await db.exec(M3);
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants`)).n === 2, 're-apply after rollback works');
await runTests(db, 'after re-apply');
await db.exec(RB);
assert((await snap()) === before, 'second rollback restores the prior state exactly');
// Committed legacy writes through the deferred trigger (separate database, so the exact-state checks above
// are not affected): legacy-only insert, writer order, re-insert, bot; then rollback keeps the real row.
{
  const d2 = new PGlite();
  await d2.exec(SCHEMA); await d2.exec(M1); await d2.exec(M2); await d2.exec(M3);
  const T = '11111111-1111-1111-1111-111111111111';
  const q = async (s) => (await d2.query(s)).rows[0];
  await d2.exec(`INSERT INTO public.app_users (user_id, email) VALUES ('44444444-0000-0000-0000-000000000001','n@x'), ('44444444-0000-0000-0000-000000000002','w@x');
    INSERT INTO public.memberships (user_id, tenant_id, role) VALUES ('44444444-0000-0000-0000-000000000001', '${T}', 'admin');`);
  const n = await q(`SELECT active_role, is_primary FROM public.user_tenants WHERE user_id = '44444444-0000-0000-0000-000000000001'`);
  assert(n && n.active_role === 'community' && n.is_primary === true, 'committed legacy-only insert: user_tenants row, community, primary');
  assert((await q(`SELECT (SELECT count(*) FROM chat_messages) + (SELECT count(*) FROM founding_members) + (SELECT count(*) FROM autopilot_recommendations) + (SELECT count(*) FROM live_rooms) AS n`)).n == 0, 'committed dual-write fired no side effect');
  await d2.exec(`BEGIN; INSERT INTO public.memberships (user_id, tenant_id) VALUES ('44444444-0000-0000-0000-000000000002', '${T}');
    INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ('${T}', '44444444-0000-0000-0000-000000000002', true); COMMIT;`);
  assert((await q(`SELECT count(*)::int n FROM live_rooms WHERE host_user_id = '44444444-0000-0000-0000-000000000002'`)).n === 1, 'writer order: the writer\'s own primary insert keeps its side effects (trigger deferred, no-op)');
  await d2.exec(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ('44444444-0000-0000-0000-000000000001', '${T}') ON CONFLICT (user_id, tenant_id) DO NOTHING;
    INSERT INTO public.tenants (tenant_id, name, slug) VALUES ('22222222-2222-2222-2222-222222222222', 'Alkalma', 'alkalma');
    INSERT INTO public.memberships (user_id, tenant_id) VALUES ('00000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222');`);
  assert((await q(`SELECT count(*)::int n FROM public.user_tenants WHERE user_id = '44444444-0000-0000-0000-000000000001'`)).n === 1, 'committed re-insert is a no-op');
  assert((await q(`SELECT count(*)::int n FROM public.user_tenants WHERE user_id = '00000000-0000-0000-0000-000000000001'`)).n === 0, 'committed bot insert writes nothing');
  assert((await q(`SELECT (public.membership_drift_report() ->> 'memberships_not_in_user_tenants')::int n`)).n === 0, 'drift memberships -> user_tenants stays 0 with the dual-write live');
  await d2.exec(RB);
  assert((await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'memberships_dualwrite_user_tenants'`)).n === 0, 'rollback drops the dual-write trigger');
  assert((await q(`SELECT count(*)::int n FROM public.user_tenants WHERE user_id = '44444444-0000-0000-0000-000000000001'`)).n === 1, 'rollback keeps the real membership the trigger wrote while live');
}
console.log('ALL OK');
