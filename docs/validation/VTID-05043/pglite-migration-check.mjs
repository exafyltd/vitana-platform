// VTID-05043 — S3 migrations A, B, C and their rollbacks, run end to end on an in-memory
// Postgres (PGlite) whose tables mirror the live columns and constraints (read from the live
// catalog, read-only, 2026-10-10). Proves the SQL logic only: SECURITY DEFINER behaviour and the
// production grants are verified after apply by post-apply-checks.sql.
//
//   mkdir /tmp/pg && cd /tmp/pg && npm i @electric-sql/pglite
//   cp <repo>/docs/validation/VTID-05043/pglite-migration-check.mjs run.mjs
//   node run.mjs <repo>
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const repo = process.argv[2];
if (!repo) { console.error('usage: node run.mjs <repo-root>'); process.exit(2); }
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const A = read('supabase/migrations/20261010180000_vtid_05043_s3_membership_side_effect_guard.sql');
const B = read('supabase/migrations/data-fixups/20261010180100_vtid_05043_s3_backfill_drifted_memberships.sql');
const C = read('supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql');
const RB_C = read('docs/validation/VTID-05043/rollback-s3-switch-tenant.sql');
const RB_B = read('docs/validation/VTID-05043/rollback-s3-backfill.sql');
const RB_A = read('docs/validation/VTID-05043/rollback-s3-guard.sql');

const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };

// Live triggers and the four trigger functions, as stubs that record that they fired.
const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
CREATE TYPE public.tenant_role AS ENUM ('community','patient','professional','staff','admin');
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text UNIQUE,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, welcome_chat_sent boolean NOT NULL DEFAULT false);
CREATE TABLE public.memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'community', status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','inactive','pending')), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, tenant_id));
CREATE TABLE public.role_preferences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id), role text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id));
CREATE TABLE public.user_tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, user_id));
CREATE TABLE public.audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, event_type text NOT NULL,
  event_data jsonb, tenant_id uuid REFERENCES public.tenants(tenant_id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.side_effect_log (fn text, user_id uuid, tenant_id uuid);
CREATE FUNCTION public.fire_welcome_chat_on_membership() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN INSERT INTO public.side_effect_log VALUES ('welcome', NEW.user_id, NEW.tenant_id); RETURN NEW; END $$;
CREATE FUNCTION public.claim_founding_seat_on_membership() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN INSERT INTO public.side_effect_log VALUES ('founding', NEW.user_id, NEW.tenant_id); RETURN NEW; END $$;
CREATE FUNCTION public.seed_onboarding_autopilot_on_membership() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN INSERT INTO public.side_effect_log VALUES ('onboarding', NEW.user_id, NEW.tenant_id); RETURN NEW; END $$;
CREATE FUNCTION public.create_user_live_room() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN INSERT INTO public.side_effect_log VALUES ('live_room', NEW.user_id, NEW.tenant_id); RETURN NEW; END $$;
CREATE TRIGGER founding_seat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION claim_founding_seat_on_membership();
CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION seed_onboarding_autopilot_on_membership();
CREATE TRIGGER trg_create_user_live_room AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION create_user_live_room();
CREATE TRIGGER welcome_chat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION fire_welcome_chat_on_membership();
CREATE SCHEMA legacy_archive;
`;
const LIVE_SWITCH = fs.readFileSync(path.join(repo, 'docs/validation/VTID-05043/live-before.sql'), 'utf8')
  .match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/)[0];

const T = { maxina: '10000000-0000-0000-0000-000000000001', alkalma: '10000000-0000-0000-0000-000000000002', earthlings: '10000000-0000-0000-0000-000000000003' };
const u = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function fresh() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(LIVE_SWITCH);
  await db.exec(`GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO PUBLIC, anon, authenticated;`);
  await db.exec(`INSERT INTO public.tenants (tenant_id, name, slug) VALUES
    ('${T.maxina}','Maxina','maxina'), ('${T.alkalma}','Alkalma','alkalma'), ('${T.earthlings}','Earthlings','earthlings')`);
  return db;
}
const q = async (db, s, p) => (await db.query(s, p)).rows;
const one = async (db, s, p) => (await q(db, s, p))[0];
const addUser = async (db, id, meta = {}) => {
  await db.query(`INSERT INTO auth.users VALUES ($1, $2)`, [id, JSON.stringify(meta)]);
  await db.query(`INSERT INTO public.app_users (user_id) VALUES ($1)`, [id]);
};
const asUser = async (db, id, slug) => {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [id ? JSON.stringify({ sub: id }) : '']);
  try { await db.query(`SELECT public.switch_to_tenant_by_slug($1)`, [slug]); return null; }
  catch (e) { return e; }
};
const sideEffects = async (db) => (await one(db, `SELECT count(*)::int n FROM public.side_effect_log`)).n;
const claimOf = async (db, id) => (await one(db, `SELECT raw_app_meta_data->>'active_tenant_id' t FROM auth.users WHERE id = $1`, [id])).t;
const auditCount = async (db) => (await one(db, `SELECT count(*)::int n FROM public.audit_events WHERE event_type = 'tenant_switch'`)).n;

// ---------------------------------------------------------------- main scenario
const db = await fresh();
// 12 drifted users with no user_tenants at all (maxina 11, alkalma 1) -> primary, suppressed.
for (let i = 1; i <= 12; i++) {
  await addUser(db, u(i));
  await db.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2)`, [u(i), i <= 11 ? T.maxina : T.alkalma]);
}
// 3 drifted alkalma users who already have a primary maxina membership -> non-primary.
for (let i = 13; i <= 15; i++) {
  await addUser(db, u(i));
  await db.query(`INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ($1, $2, true)`, [T.maxina, u(i)]);
  await db.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2)`, [u(i), T.alkalma]);
}
// 2 orphaned legacy memberships of deleted accounts (no auth.users, no app_users) -> left alone.
await db.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2), ($3, $2)`, [u(901), T.maxina, u(902)]);
// An inactive legacy membership -> not drift.
await addUser(db, u(30));
await db.query(`INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ($1, $2, true)`, [T.maxina, u(30)]);
await db.query(`INSERT INTO public.memberships (user_id, tenant_id, status) VALUES ($1, $2, 'inactive')`, [u(30), T.alkalma]);
// Claims: 40 points at earthlings (not a member, primary maxina) -> maxina; 41 has no membership -> key removed;
// 42 exafy_admin pointing at earthlings -> untouched; 1 (drift user) points at maxina -> valid after backfill.
await addUser(db, u(40), { active_tenant_id: T.earthlings });
await db.query(`INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ($1, $2, true)`, [T.maxina, u(40)]);
await addUser(db, u(41), { active_tenant_id: T.earthlings, provider: 'email' });
await addUser(db, u(42), { active_tenant_id: T.earthlings, exafy_admin: true });
await db.query(`UPDATE auth.users SET raw_app_meta_data = jsonb_build_object('active_tenant_id', $2::text) WHERE id = $1`, [u(1), T.maxina]);
await db.exec(`DELETE FROM public.side_effect_log`);
const utBefore = (await one(db, `SELECT count(*)::int n FROM public.user_tenants`)).n;

// Migration A
await db.exec(A);
const trg = await q(db, `SELECT tgname, pg_get_triggerdef(oid) d FROM pg_trigger WHERE tgrelid = 'public.user_tenants'::regclass AND NOT tgisinternal ORDER BY 1`);
assert(trg.length === 4, 'A: four triggers on user_tenants');
assert(trg.every((t) => /is_primary = true\) AND \(NOT (public\.)?membership_side_effects_suppressed\(\)\)/.test(t.d)), 'A: every trigger carries the guard: ' + trg[0].d);
assert(trg.every((t) => /AFTER INSERT ON public\.user_tenants FOR EACH ROW/.test(t.d)), 'A: timing unchanged');
assert((await q(db, `SELECT slug FROM public.tenants WHERE open_signup ORDER BY slug`)).map((r) => r.slug).join() === 'alkalma,maxina', 'A: open_signup = {alkalma, maxina}');
assert((await one(db, `SELECT public.membership_side_effects_suppressed() s`)).s === false, 'A: guard off by default');
await db.exec(A);
assert((await q(db, `SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'public.user_tenants'::regclass AND NOT tgisinternal`))[0].n === 4, 'A: re-run is clean (still four triggers)');

// Migration B
await db.exec(B);
const utAfter = (await one(db, `SELECT count(*)::int n FROM public.user_tenants`)).n;
assert(utAfter - utBefore === 15, `B: inserted 15 drifted memberships (${utAfter - utBefore})`);
assert(await sideEffects(db) === 0, 'B: 0 side effects (welcome, seat, onboarding, live room) for the backfill');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE is_primary AND user_id IN (${[...Array(12)].map((_, i) => `'${u(i + 1)}'`).join()})`)).n === 12, 'B: the 12 users without a primary got one');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE tenant_id = $1 AND is_primary AND user_id IN ('${u(13)}','${u(14)}','${u(15)}')`, [T.alkalma])).n === 0, 'B: users who had a primary get a non-primary row');
assert((await one(db, `SELECT count(*)::int n FROM public.app_users WHERE welcome_chat_sent AND user_id IN (${[...Array(15)].map((_, i) => `'${u(i + 1)}'`).join()})`)).n === 15, 'B: welcome_chat_sent = true for all 15');
assert((await one(db, `SELECT count(*)::int n FROM public.app_users WHERE welcome_chat_sent AND user_id NOT IN (${[...Array(15)].map((_, i) => `'${u(i + 1)}'`).join()})`)).n === 0, 'B: nobody else touched');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id IN ('${u(901)}','${u(902)}')`)).n === 0, 'B: orphaned memberships of deleted accounts left alone');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = $1 AND tenant_id = $2`, [u(30), T.alkalma])).n === 0, 'B: inactive legacy membership not backfilled');
assert((await one(db, `SELECT count(*)::int n FROM legacy_archive.bak_s3_drift_20261010`)).n === 17, 'B: drift snapshot = 15 + 2 orphans');
assert(await claimOf(db, u(40)) === T.maxina, 'B: bad claim reset to the primary tenant');
assert(await claimOf(db, u(41)) === null && (await one(db, `SELECT raw_app_meta_data->>'provider' p FROM auth.users WHERE id = $1`, [u(41)])).p === 'email', 'B: bad claim without membership removed, other metadata kept');
assert(await claimOf(db, u(42)) === T.earthlings, 'B: exafy_admin claim untouched');
assert(await claimOf(db, u(1)) === T.maxina, 'B: a claim made valid by the backfill is untouched');
assert((await one(db, `SELECT count(*)::int n FROM legacy_archive.bak_s3_claims_20261010`)).n === 2, 'B: claims snapshot = 2');
assert((await one(db, `SELECT coalesce(current_setting('vitana.suppress_membership_side_effects', true), '') v`)).v !== 'on', 'B: suppression setting gone after COMMIT');
assert((await one(db, `SELECT public.membership_side_effects_suppressed() s`)).s === false, 'B: guard off after COMMIT');
let rerun = null; try { await db.exec(B); } catch (e) { rerun = e; }
assert(rerun && /already exists/.test(rerun.message), 'B: second run fails loudly (snapshot exists): ' + (rerun && rerun.message));
await db.exec('ROLLBACK').catch(() => {});
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants`)).n === utAfter, 'B: failed re-run changed nothing');

// Primary insert outside the fix-up -> side effects fire normally.
await addUser(db, u(50));
await db.query(`INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ($1, $2, true)`, [T.maxina, u(50)]);
assert(await sideEffects(db) === 4, 'primary insert outside the fix-up fires all 4 side effects');
await db.exec(`DELETE FROM public.side_effect_log`);
// Same insert with the setting on (transaction-local) -> suppressed, and only for that transaction.
await addUser(db, u(51));
await db.exec(`BEGIN; SELECT set_config('vitana.suppress_membership_side_effects','on',true);
  INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ('${T.maxina}','${u(51)}',true); COMMIT;`);
assert(await sideEffects(db) === 0, 'primary insert with the transaction-local setting fires nothing');

// Migration C
await db.exec(C);
assert((await one(db, `SELECT has_function_privilege('anon','public.switch_to_tenant_by_slug(text)','execute') a`)).a === false, 'C: anon cannot execute');
assert((await one(db, `SELECT has_function_privilege('authenticated','public.switch_to_tenant_by_slug(text)','execute') a`)).a === true, 'C: authenticated can execute');
assert((await one(db, `SELECT prosecdef FROM pg_proc WHERE proname = 'switch_to_tenant_by_slug'`)).prosecdef === true, 'C: still SECURITY DEFINER');

let e = await asUser(db, u(40), 'earthlings');
assert(e && e.code === '42501' && /TENANT_NOT_JOINABLE/.test(e.message), 'C: non-member -> closed tenant raises 42501 TENANT_NOT_JOINABLE');
assert((await one(db, `SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND tenant_id = $2`, [u(40), T.earthlings])).n === 0, 'C: ...and wrote no membership');
assert(await claimOf(db, u(40)) === T.maxina, 'C: ...and did not move the claim');

e = await asUser(db, null, 'maxina');
assert(e && e.code === '42501', 'C: no auth.uid() raises 42501');
e = await asUser(db, u(40), 'nope');
assert(e && /Tenant not found/.test(e.message), 'C: unknown slug raises');

await addUser(db, u(60));
let audit0 = await auditCount(db);
e = await asUser(db, u(60), 'alkalma');
assert(e === null, 'C: new user joins alkalma (open signup)');
const r60 = await one(db, `SELECT is_primary, active_role FROM public.user_tenants WHERE user_id = $1 AND tenant_id = $2`, [u(60), T.alkalma]);
assert(r60 && r60.is_primary === true && r60.active_role === 'community', 'C: first membership is primary, community');
assert((await one(db, `SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND tenant_id = $2 AND role = 'community' AND status = 'active'`, [u(60), T.alkalma])).n === 1, 'C: legacy membership written');
assert((await one(db, `SELECT role FROM public.role_preferences WHERE user_id = $1 AND tenant_id = $2`, [u(60), T.alkalma])).role === 'community', 'C: role preference community');
assert(await claimOf(db, u(60)) === T.alkalma, 'C: claim -> alkalma');
assert(await sideEffects(db) === 4, 'C: a real new primary member fires the 4 side effects (intended)');
assert(await auditCount(db) === audit0 + 1, 'C: one audit row');

e = await asUser(db, u(60), 'maxina');
assert(e === null, 'C: same user joins maxina');
assert((await one(db, `SELECT is_primary FROM public.user_tenants WHERE user_id = $1 AND tenant_id = $2`, [u(60), T.maxina])).is_primary === false, 'C: second membership is NOT primary');
assert(await sideEffects(db) === 4, 'C: non-primary join fires nothing');
assert(await claimOf(db, u(60)) === T.maxina, 'C: claim -> maxina');

const ut60 = (await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = $1`, [u(60)])).n;
audit0 = await auditCount(db);
const xmin0 = (await one(db, `SELECT xmin::text x FROM auth.users WHERE id = $1`, [u(60)])).x;
e = await asUser(db, u(60), 'maxina');
assert(e === null, 'C: repeat call succeeds');
assert((await one(db, `SELECT xmin::text x FROM auth.users WHERE id = $1`, [u(60)])).x === xmin0, 'C: repeat call -> 0 rows updated in auth.users');
assert(await auditCount(db) === audit0, 'C: repeat call -> 0 audit rows added');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = $1`, [u(60)])).n === ut60, 'C: repeat call -> no membership rows added');

// Existing member of a closed tenant switches fine; exafy_admin switches without joining.
await db.query(`INSERT INTO public.user_tenants (tenant_id, user_id) VALUES ($1, $2)`, [T.earthlings, u(40)]);
audit0 = await auditCount(db);
e = await asUser(db, u(40), 'earthlings');
assert(e === null && await claimOf(db, u(40)) === T.earthlings, 'C: existing member of a closed tenant switches');
assert(await auditCount(db) === audit0 + 1, 'C: ...with one audit row (claim changed)');
assert((await one(db, `SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND tenant_id = $2`, [u(40), T.earthlings])).n === 0, 'C: ...and no legacy membership written');
e = await asUser(db, u(42), 'alkalma');
assert(e === null && await claimOf(db, u(42)) === T.alkalma, 'C: exafy_admin switches to a tenant it is not a member of');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = $1`, [u(42)])).n === 0, 'C: ...without becoming a member');
// A drifted user (now backfilled) re-entering their tenant: switch only, no writes beyond the claim.
e = await asUser(db, u(13), 'alkalma');
assert(e === null && await claimOf(db, u(13)) === T.alkalma, 'C: backfilled member switches to their tenant');

// ---------------------------------------------------------------- rollbacks
await db.exec(RB_C);
e = await asUser(db, u(60), 'maxina');
assert(e && /tenant_record|has no field "id"/.test(e.message), 'rollback C: live body restored verbatim (raises on missing id, as before): ' + (e && e.message));
assert((await one(db, `SELECT has_function_privilege('anon','public.switch_to_tenant_by_slug(text)','execute') a`)).a === true, 'rollback C: anon grant restored');

const before = (await one(db, `SELECT count(*)::int n FROM public.user_tenants`)).n;
await db.exec(RB_B);
assert(before - (await one(db, `SELECT count(*)::int n FROM public.user_tenants`)).n === 15, 'rollback B: exactly the 15 backfilled rows deleted');
assert((await one(db, `SELECT count(*)::int n FROM public.user_tenants WHERE user_id = $1`, [u(60)])).n === 2, 'rollback B: memberships created later are kept');
assert((await one(db, `SELECT count(*)::int n FROM public.app_users WHERE welcome_chat_sent AND user_id IN (${[...Array(15)].map((_, i) => `'${u(i + 1)}'`).join()})`)).n === 0, 'rollback B: welcome_chat_sent restored');
assert(await claimOf(db, u(41)) === T.earthlings, 'rollback B: removed claim restored');

await db.exec(RB_A);
const trg2 = await q(db, `SELECT pg_get_triggerdef(oid) d FROM pg_trigger WHERE tgrelid = 'public.user_tenants'::regclass AND NOT tgisinternal`);
assert(trg2.length === 4 && trg2.every((t) => /WHEN \(\(new\.is_primary = true\)\) EXECUTE/.test(t.d)), 'rollback A: original WHEN restored');
assert((await one(db, `SELECT count(*)::int n FROM pg_proc WHERE proname = 'membership_side_effects_suppressed'`)).n === 0, 'rollback A: helper dropped');
await db.exec(`DELETE FROM public.side_effect_log`);
await addUser(db, u(70));
await db.exec(`BEGIN; SELECT set_config('vitana.suppress_membership_side_effects','on',true);
  INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ('${T.maxina}','${u(70)}',true); COMMIT;`);
assert(await sideEffects(db) === 4, 'rollback A: triggers fire unguarded again');

// ---------------------------------------------------------------- B aborts
{
  const d2 = await fresh();
  await d2.exec(A);
  await addUser(d2, u(1));
  await d2.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2)`, [u(1), T.earthlings]);
  let err = null; try { await d2.exec(B); } catch (x) { err = x; }
  assert(err && /tenant without open_signup/.test(err.message), 'B aborts when a drifted membership is in a closed tenant');
  await d2.exec('ROLLBACK').catch(() => {});
  assert((await one(d2, `SELECT count(*)::int n FROM public.user_tenants`)).n === 0, '...and writes nothing');
}
{
  const d3 = await fresh();
  await d3.exec(A);
  for (let i = 1; i <= 31; i++) {
    await addUser(d3, u(i));
    await d3.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2)`, [u(i), T.maxina]);
  }
  let err = null; try { await d3.exec(B); } catch (x) { err = x; }
  assert(err && /expected <= 30/.test(err.message), 'B aborts above 30 drifted memberships');
}
{
  const d4 = await fresh();
  await d4.exec(A);
  await d4.query(`INSERT INTO auth.users VALUES ($1, '{}')`, [u(1)]);
  await d4.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2)`, [u(1), T.maxina]);
  let err = null; try { await d4.exec(B); } catch (x) { err = x; }
  assert(err && /without app_users/.test(err.message), 'B aborts when a real auth user would be left without a membership');
}
{
  const d5 = await fresh();
  await d5.exec(A);
  for (let i = 1; i <= 51; i++) await addUser(d5, u(i), { active_tenant_id: T.earthlings });
  let err = null; try { await d5.exec(B); } catch (x) { err = x; }
  assert(err && /expected <= 50/.test(err.message), 'B aborts above 50 bad claims');
}
console.log('ALL MIGRATION CHECKS PASSED');
