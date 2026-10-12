// VTID-05124 (FU8) — the orphan-memberships data fix-up and its rollback, run end to end on an
// in-memory Postgres (PGlite) whose tables mirror the live columns and constraints (read from the
// live catalog, read-only, 2026-10-12). Same harness pattern as VTID-05043. Proves the SQL logic
// only; the production result is verified after apply by post-apply-checks.sql.
//
//   mkdir /tmp/pg && cd /tmp/pg && npm i @electric-sql/pglite
//   cp <repo>/docs/validation/VTID-05124/pglite-migration-check.mjs run.mjs
//   node run.mjs <repo>
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const repo = process.argv[2];
if (!repo) { console.error('usage: node run.mjs <repo-root>'); process.exit(2); }
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const M = read('supabase/migrations/data-fixups/20261012214500_vtid_05124_delete_orphan_memberships.sql');
const RB = read('docs/validation/VTID-05124/rollback-orphan-memberships.sql');
const ARCHIVE = 'legacy_archive.bak_fu8_orphan_memberships_20261012';

const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };

// Live: memberships has only its pkey, the status check, UNIQUE (user_id, tenant_id) and the
// tenants FK; no FK on user_id and no triggers. app_users.user_id -> auth.users, user_tenants.user_id
// -> app_users, profiles.user_id -> auth.users. profiles is modelled without its FK so a test can
// seed a profile for a user id that has no auth.users row (the guard must still catch it).
const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TYPE public.tenant_role AS ENUM ('community','patient','professional','reseller','staff','admin','backoffice','developer','infra');
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE);
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'community', status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','inactive','pending')), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, tenant_id));
CREATE TABLE public.user_tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE SCHEMA legacy_archive;
REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC;
`;

const T = { maxina: '10000000-0000-0000-0000-000000000001', alkalma: '10000000-0000-0000-0000-000000000002' };
const u = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const q = async (db, s, p) => (await db.query(s, p)).rows;
const one = async (db, s, p) => (await q(db, s, p))[0];
const count = async (db, s, p) => (await one(db, s, p)).n;

async function fresh() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`INSERT INTO public.tenants VALUES ('${T.maxina}','Maxina','maxina'), ('${T.alkalma}','Alkalma','alkalma')`);
  return db;
}
// A real, live member: auth.users + app_users + user_tenants + profiles + a legacy membership.
async function addMember(db, id, tenant, status = 'active') {
  await db.query(`INSERT INTO auth.users VALUES ($1)`, [id]);
  await db.query(`INSERT INTO public.app_users VALUES ($1)`, [id]);
  await db.query(`INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES ($1, $2, true)`, [tenant, id]);
  await db.query(`INSERT INTO public.profiles (user_id) VALUES ($1)`, [id]);
  await db.query(`INSERT INTO public.memberships (user_id, tenant_id, status) VALUES ($1, $2, $3)`, [id, tenant, status]);
}
// A deleted account's leftover: a memberships row only, with fixed historic timestamps.
async function addOrphan(db, id, tenant, role = 'community', day = 1) {
  const ts = `2025-10-${String(day).padStart(2, '0')} 12:34:56.789012+00`;
  await db.query(`INSERT INTO public.memberships (user_id, tenant_id, role, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`, [id, tenant, role, ts]);
}
// The live shape: 12 rows = maxina 11 + alkalma 1; 11 distinct users (one in both tenants); 1 reseller.
async function seedLiveOrphans(db, n = 12) {
  for (let i = 1; i <= n; i++) {
    if (i === 12) await addOrphan(db, u(901), T.alkalma, 'community', i);           // same user as row 1
    else await addOrphan(db, u(900 + i), T.maxina, i === 2 ? 'reseller' : 'community', i);
  }
}
const snapshot = async (db) => JSON.stringify(await q(db, `SELECT row_to_json(m)::text r FROM public.memberships m ORDER BY id`));
const archiveExists = async (db) => (await one(db, `SELECT to_regclass('${ARCHIVE}')::text t`)).t !== null;
async function expectAbort(db, sql, re, label) {
  const before = await snapshot(db);
  let err = null; try { await db.exec(sql); } catch (x) { err = x; }
  await db.exec('ROLLBACK').catch(() => {});
  assert(err && re.test(err.message), `${label}: ${err && err.message}`);
  assert(await snapshot(db) === before, `${label} -> memberships unchanged`);
  return err;
}

// ---------------------------------------------------------------- main scenario
const db = await fresh();
await seedLiveOrphans(db);
for (let i = 1; i <= 5; i++) await addMember(db, u(i), i <= 3 ? T.maxina : T.alkalma);
await addMember(db, u(6), T.maxina, 'inactive');
const before = await snapshot(db);
const realBefore = await q(db, `SELECT row_to_json(m)::text r FROM public.memberships m WHERE user_id < '${u(900)}' ORDER BY id`);
assert(await count(db, `SELECT count(*)::int n FROM public.memberships`) === 18, 'seed: 18 memberships (12 orphans + 6 real)');

await db.exec(M);
assert(await count(db, `SELECT count(*)::int n FROM public.memberships`) === 6, 'apply: 18 -> 6 memberships');
assert(await count(db, `SELECT count(*)::int n FROM public.memberships WHERE user_id >= '${u(900)}'`) === 0, 'apply: every orphan deleted');
assert(JSON.stringify(await q(db, `SELECT row_to_json(m)::text r FROM public.memberships m ORDER BY id`)) === JSON.stringify(realBefore), 'apply: real members\' rows untouched, byte-identical (incl. the inactive one)');
assert(await count(db, `SELECT count(*)::int n FROM ${ARCHIVE}`) === 12, 'apply: archive holds 12 rows');
assert(await count(db, `SELECT count(DISTINCT user_id)::int n FROM ${ARCHIVE}`) === 11, 'apply: ...of 11 distinct users');
const cols = (await q(db, `SELECT column_name c FROM information_schema.columns WHERE table_schema = 'legacy_archive' AND table_name = 'bak_fu8_orphan_memberships_20261012' ORDER BY ordinal_position`)).map((r) => r.c).join();
assert(cols === 'id,user_id,tenant_id,role,status,created_at,updated_at,captured_at', 'apply: archive has all 7 columns + captured_at: ' + cols);
assert((await one(db, `SELECT has_table_privilege('anon','${ARCHIVE}','select') a, has_table_privilege('authenticated','${ARCHIVE}','select') b`)).a === false, 'apply: anon cannot read the archive');
assert((await one(db, `SELECT has_table_privilege('authenticated','${ARCHIVE}','select') b`)).b === false, 'apply: authenticated cannot read the archive');
assert(await count(db, `SELECT count(*)::int n FROM public.memberships m WHERE NOT EXISTS (SELECT 1 FROM auth.users x WHERE x.id = m.user_id)`) === 0, 'apply: post-check orphans = 0');

await expectAbort(db, M, /already exists/, 'second run fails loudly (archive exists)');
assert(await count(db, `SELECT count(*)::int n FROM ${ARCHIVE}`) === 12, '...and the archive is untouched');

// Rollback: the archived rows come back with the same ids, values and timestamps.
await db.exec(RB);
assert(await snapshot(db) === before, 'rollback: memberships restored byte-identical to before the migration');
await db.exec(RB);
assert(await snapshot(db) === before, 'rollback re-run is a no-op (ON CONFLICT (id) DO NOTHING)');

// Rollback aborts if a deleted (user, tenant) was re-created with a new id meanwhile.
{
  const d = await fresh();
  await seedLiveOrphans(d);
  await d.exec(M);
  await d.query(`INSERT INTO public.memberships (user_id, tenant_id) VALUES ($1, $2)`, [u(903), T.maxina]);
  await expectAbort(d, RB, /memberships_user_id_tenant_id_key|duplicate key/, 'rollback aborts on a re-created (user_id, tenant_id)');
}

// ---------------------------------------------------------------- aborts
{
  const d = await fresh();
  await seedLiveOrphans(d, 11);
  for (let i = 13; i <= 21; i++) await addOrphan(d, u(900 + i), T.maxina);   // 20 orphans
  await expectAbort(d, M, /20 orphan memberships \(expected 10\.\.14/, 'aborts on 20 orphans (count guard, upper)');
  assert(!(await archiveExists(d)), '...and leaves no archive table');
}
{
  const d = await fresh();
  await seedLiveOrphans(d, 9);
  await expectAbort(d, M, /9 orphan memberships \(expected 10\.\.14/, 'aborts on 9 orphans (count guard, lower)');
}
{
  const d = await fresh();
  await seedLiveOrphans(d, 14);
  await d.exec(M);
  assert(await count(d, `SELECT count(*)::int n FROM public.memberships`) === 0, 'boundary: 14 orphans are deleted');
}
{
  const d = await fresh();
  await seedLiveOrphans(d);
  await d.query(`INSERT INTO public.profiles (user_id) VALUES ($1)`, [u(905)]);
  await expectAbort(d, M, /belong to a user with user_tenants or profiles rows/, 'aborts when an orphan has a profiles row (profiles.user_id)');
  assert(!(await archiveExists(d)), '...and leaves no archive table');
}
{
  const d = await fresh();
  await seedLiveOrphans(d);
  await d.query(`INSERT INTO public.profiles (id) VALUES ($1)`, [u(906)]);
  await expectAbort(d, M, /belong to a user with user_tenants or profiles rows/, 'aborts when an orphan has a profiles row (profiles.id)');
}
{
  const d = await fresh();
  await seedLiveOrphans(d);
  await d.exec(`CREATE TABLE public.membership_notes (membership_id uuid REFERENCES public.memberships(id))`);
  await expectAbort(d, M, /1 foreign keys now reference public\.memberships/, 'aborts when a FK references memberships');
}
console.log('ALL MIGRATION CHECKS PASSED');
