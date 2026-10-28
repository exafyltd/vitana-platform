// VTID-05143 (VTID-05085 Phase 1) — applies migration
// 20261013200000_vtid_05143_unified_card_system.sql to a throwaway in-memory
// Postgres (PGlite) with minimal stand-ins for auth.* and profiles, twice
// (idempotency), and checks the table, the column and the RLS policies.
// Never touches any real database.
// Run: node pglite-unified-card-system-check.mjs <path-to-migration>
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';

const migration = readFileSync(process.argv[2], 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT coalesce(nullif(current_setting('test.role', true), ''), 'anon') $$;
  GRANT USAGE ON SCHEMA auth TO authenticated, service_role, anon;
  CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, bio text, avatar_url text);
  INSERT INTO auth.users VALUES ('${A}'), ('${B}');
  INSERT INTO public.profiles (user_id, bio) VALUES ('${A}', 'existing row');
`);

try {
  await db.exec(migration);
  check('migration applies', true);
} catch (e) { check('migration applies', false, e.message); }
try {
  await db.exec(migration);
  check('migration re-applies (idempotent)', true);
} catch (e) { check('migration re-applies (idempotent)', false, e.message); }

const cols = await db.query(`SELECT column_name, column_default
  FROM information_schema.columns WHERE table_name = 'user_enrichment_cards' ORDER BY ordinal_position`);
const names = cols.rows.map((r) => r.column_name);
check('user_enrichment_cards columns', JSON.stringify(names) === JSON.stringify(['user_id', 'card_type', 'dismissed_at', 'cooldown_days', 'created_at', 'updated_at']), names.join(','));
check('no completed_at column (plan F12)', !names.includes('completed_at'));
const cd = cols.rows.find((r) => r.column_name === 'cooldown_days');
check('cooldown_days defaults to 7', !!cd && String(cd.column_default) === '7');

const interests = await db.query(`SELECT data_type FROM information_schema.columns
  WHERE table_name = 'profiles' AND column_name = 'interests'`);
check('profiles.interests is text[]', interests.rows[0]?.data_type === 'ARRAY');
const existing = await db.query(`SELECT interests FROM public.profiles WHERE user_id = '${A}'`);
check('existing profile gets empty interests', Array.isArray(existing.rows[0]?.interests) && existing.rows[0].interests.length === 0);

const pk = await db.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = 'public.user_enrichment_cards'::regclass AND i.indisprimary ORDER BY a.attname`);
check('primary key (card_type, user_id)', pk.rows.map((r) => r.attname).join(',') === 'card_type,user_id');
const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'user_enrichment_cards' AND indexname = 'idx_user_enrichment_cards_user'`);
check('user index exists', idx.rows.length === 1);
const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_enrichment_cards'::regclass`);
check('RLS enabled', rls.rows[0]?.relrowsecurity === true);
const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'user_enrichment_cards'`);
check('4 policies (no duplicates after re-run)', pol.rows[0]?.n === 4, String(pol.rows[0]?.n));
const cmt = await db.query(`SELECT obj_description('public.user_enrichment_cards'::regclass) AS c`);
check('table comment names VTID-05085 and VTID-05143', /VTID-05085/.test(cmt.rows[0]?.c ?? '') && /VTID-05143/.test(cmt.rows[0]?.c ?? ''));

// RLS as members: A writes own row; A cannot write or read B's row.
await db.exec(`GRANT SELECT, INSERT, UPDATE ON public.user_enrichment_cards TO authenticated, service_role`);
await db.exec(`INSERT INTO public.user_enrichment_cards (user_id, card_type, dismissed_at) VALUES ('${B}', 'E1', now())`);
await db.exec(`SET test.uid = '${A}'; SET test.role = 'authenticated'; SET ROLE authenticated;`);
try {
  await db.exec(`INSERT INTO public.user_enrichment_cards (user_id, card_type, dismissed_at) VALUES ('${A}', 'E1', now())`);
  check('member inserts own row', true);
} catch (e) { check('member inserts own row', false, e.message); }
try {
  await db.exec(`INSERT INTO public.user_enrichment_cards (user_id, card_type, dismissed_at) VALUES ('${B}', 'E2', now())`);
  check('member cannot insert another member row', false, 'insert succeeded');
} catch { check('member cannot insert another member row', true); }
const seen = await db.query(`SELECT user_id FROM public.user_enrichment_cards`);
check('member sees only own rows', seen.rows.length === 1 && seen.rows[0].user_id === A, JSON.stringify(seen.rows));
const upd = await db.query(`UPDATE public.user_enrichment_cards SET dismissed_at = now() WHERE user_id = '${B}' RETURNING user_id`);
check('member cannot update another member row', upd.rows.length === 0);
await db.exec(`RESET ROLE; SET test.role = 'service_role'; SET test.uid = ''; SET ROLE service_role;`);
const all = await db.query(`SELECT count(*)::int AS n FROM public.user_enrichment_cards`);
check('service_role sees every row', all.rows[0]?.n === 2);
await db.exec('RESET ROLE');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
