// Applies both migrations to a PGlite stand-in with sample data, runs pre/post/rollback checks and the rollback file.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(f, 'utf8');
const db = new PGlite();
await db.exec(`DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
await db.exec(rd('docs/validation/VTID-05572/pglite-harness/base_schema.sql'));
await db.exec(`
INSERT INTO tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','A','a'),('22222222-2222-4222-8222-222222222222','B','b');
INSERT INTO app_users(user_id,email) SELECT ('00000000-0000-4000-8000-0000000000'||lpad(i::text,2,'0'))::uuid,'u'||i||'@x' FROM generate_series(10,15) i;
INSERT INTO user_tenants(tenant_id,user_id,is_primary) VALUES
 ('11111111-1111-4111-8111-111111111111','00000000-0000-4000-8000-000000000010',true),
 ('11111111-1111-4111-8111-111111111111','00000000-0000-4000-8000-000000000011',true),
 ('22222222-2222-4222-8222-222222222222','00000000-0000-4000-8000-000000000011',false),
 ('22222222-2222-4222-8222-222222222222','00000000-0000-4000-8000-000000000012',true);
INSERT INTO profiles(user_id) SELECT ('00000000-0000-4000-8000-0000000000'||lpad(i::text,2,'0'))::uuid FROM generate_series(10,14) i;`);
const show = async (t, sql) => { const r = await db.query(sql); console.log(`-- ${t}\n` + JSON.stringify(r.rows)); };
const sel = (f) => rd(f).split(/;\s*\n/).map(s => s.replace(/^(--.*\n)+/gm,'').trim()).filter(s => /^SELECT/i.test(s));
const run = async (title, f) => { console.log(`\n== ${title}`); for (const s of sel(f)) await show(s.slice(0,60).replace(/\s+/g,' '), s); };
await db.exec(rd('supabase/migrations/20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql'));
await run('pre-check', 'docs/validation/VTID-05572/pre-check.sql');
await db.exec(rd('supabase/migrations/20261102042100_vtid_05572_profiles_tenant_backfill_run.sql'));
await run('post-check', 'docs/validation/VTID-05572/post-check.sql');
await show('profiles', `SELECT right(user_id::text,2) u, tenant_id IS NOT NULL has_tenant FROM profiles ORDER BY 1`);
await db.exec(rd('supabase/migrations/20261102042100_vtid_05572_profiles_tenant_backfill_run.sql'));
await show('second apply is a no-op', `SELECT count(*) log_rows FROM legacy_archive.mt_profiles_tenant_backfill_log`);
await db.exec(rd('docs/validation/VTID-05572/rollback-042100-profiles-tenant-backfill.sql'));
await run('rollback-check', 'docs/validation/VTID-05572/rollback-check.sql');
await show('profiles after rollback', `SELECT count(*) FILTER (WHERE tenant_id IS NOT NULL) with_tenant FROM profiles`);
