#!/usr/bin/env node
// VTID-05569 owner packet dry-run. In-process PGlite only: no network, no live or shared database, nothing applied.
//   node docs/validation/VTID-05569/owner-packet-outputs/dry-run.mjs > docs/validation/VTID-05569/owner-packet-outputs/dry-run.txt
// A: the replayed local stack (scripts/mt/stack) - what the read-only assertion does on a fresh replay.
// B: the lane's stand-in schema (docs/validation/VTID-05569/pglite-harness/base_schema.sql + the real product_analytics_events DDL)
//    - pre-check, the assertion, post-check, the no-op rollback, rollback-check, and the two refusals (orphan row, nullable column).
// C: the 11-case pgTAP file on the lane's pgTAP-compatible shim.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createStack } from '../../../../scripts/mt/stack/stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const V = (f) => rd('docs/validation/VTID-05569', f);
const H = (f) => rd('docs/validation/VTID-05569/pglite-harness', f);
const ASSERT = '20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql';
const ROLLBACK = '20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql';
const mig = (f) => rd('supabase/migrations', f);
const first = (e) => String((e && e.message) || e).split('\n')[0];
let bad = 0;
const say = (s) => console.log(s);
async function show(db, file, label) {
  const res = await db.exec(V(file));
  say(`--- ${label}: ${file}`);
  for (const r of res) for (const row of r.rows || []) say('  ' + JSON.stringify(row));
}
async function apply(db, label, sql, { expect } = {}) {
  try {
    await db.exec(sql);
    if (expect) { bad++; say(`FAIL ${label}: expected a refusal, it applied`); } else say(`PASS ${label}`);
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch {}
    const m = first(e);
    if (expect && m.includes(expect)) say(`PASS ${label}: refused as expected: ${m}`);
    else { bad++; say(`FAIL ${label}: ${m}`); }
  }
}
const PAE = rd('supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql').split('\n').filter((l) => !/create extension/i.test(l)).join('\n');
const BASE = `DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;`;
async function lab() { const db = new PGlite(); await db.exec(BASE); await db.exec(H('shim.sql')); await db.exec(H('base_schema.sql')); await db.exec(PAE); return db; }

say('# VTID-05569 owner-packet dry-run. PGlite in process; nothing applied anywhere.');
say(`# node ${process.version}`);

say('\n## A. replayed local stack (supabase/migrations/*.sql replayed, replay-skip.json honoured)');
{
  const { db, report } = await createStack({ fixtures: false, shim: false });
  say(`replay: ${report.replay.applied.length} applied, ${report.replay.skipped.length} skipped, ${report.replay.failed.length} failed`);
  say('tenant_id column on the three tables after the replay: ' + JSON.stringify((await db.query(`SELECT t.t AS table_name, c.is_nullable FROM (VALUES ('chat_messages'),('user_notifications'),('product_analytics_events')) t(t) LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=t.t AND c.column_name='tenant_id' ORDER BY 1`)).rows));
  await apply(db, `apply ${ASSERT} (on the replay, 20260225200000_chat_messages.sql is a recorded skip, so chat_messages has no tenant_id here)`, mig(ASSERT), { expect: 'does not exist' });
  await db.close();
}

say('\n## B. lane stand-in schema (tenants, user_tenants, chat_messages, user_notifications, real product_analytics_events DDL)');
{
  let db = await lab();
  await show(db, 'pre-check.sql', 'PRE');
  await apply(db, `apply ${ASSERT}`, mig(ASSERT));
  await show(db, 'post-check.sql', 'POST');
  await apply(db, `re-apply ${ASSERT} (read-only, repeatable)`, mig(ASSERT));
  await apply(db, `apply rollback ${ROLLBACK} (no-op)`, mig(ROLLBACK));
  await show(db, 'rollback-check.sql', 'ROLLBACK-CHECK');
  await db.close();

  db = await lab();
  await db.exec(`INSERT INTO public.user_notifications (user_id, tenant_id, type, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'dryrun', 'orphan row on a tenant that does not exist')`);
  await show(db, 'pre-check.sql', 'PRE with one orphan row in the stand-in');
  await apply(db, `apply ${ASSERT} with one orphan row`, mig(ASSERT), { expect: 'whose tenant_id is not an existing tenant' });
  await db.close();

  db = await lab();
  await db.exec(`ALTER TABLE public.chat_messages ALTER COLUMN tenant_id DROP NOT NULL`);
  await show(db, 'pre-check.sql', 'PRE with chat_messages.tenant_id made nullable in the stand-in');
  await apply(db, `apply ${ASSERT} with a nullable column`, mig(ASSERT), { expect: 'is nullable' });
  await db.close();
}

say('\n## C. pgTAP file vtid_mt_data_cleanup_notnull_assert.test.sql (11 cases) on the lane shim');
{
  const db = await lab();
  await db.exec(mig(ASSERT));
  const sql = rd('supabase/tests/vtid_mt_data_cleanup_notnull_assert.test.sql').replace(/CREATE EXTENSION IF NOT EXISTS pgtap[^;]*;/gi, '');
  const lines = [];
  try {
    const res = await db.exec(sql);
    for (const r of res) for (const row of r.rows || []) { const v = Object.values(row)[0]; if (typeof v === 'string' && /^(ok|not ok|1\.\.|#)/.test(v)) lines.push(v); }
  } catch (e) { lines.push('# SQL ERROR: ' + first(e)); }
  const uniq = [...new Map(lines.filter((l) => /^(not )?ok \d+/.test(l)).map((l) => [l.split(' - ')[0], l])).values()];
  const nok = uniq.filter((l) => l.startsWith('not ok')).length + lines.filter((l) => l.startsWith('# SQL ERROR')).length;
  uniq.forEach((l) => say('  ' + l));
  say(`${nok === 0 && uniq.length === 11 ? 'PASS' : 'FAIL'} pgTAP: ${uniq.length - nok} ok of ${uniq.length} (plan 11)`); if (nok || uniq.length !== 11) bad++;
  await db.close();
}
say(`\nRESULT: ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
