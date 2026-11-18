// VTID-05520 (mt-guardrails-r2/local-test-stack-pglite): unit tests of the PGlite loader over tiny synthetic
// migration trees. No repo migration is replayed here (repo-gate.test.mjs does that).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  listMigrations,
  replay,
  checkRequiredTables,
  parseTableList,
  parseNotReplayable,
  loadFixtures,
} from '../../../scripts/mt/stack/stack.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mt-stack-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('stub auth schema (Amendment 2, decision 4)', () => {
  let db;
  before(async () => { db = await openDb(); });
  after(async () => { await db.close(); });

  test('holds auth.users, auth.uid(), auth.jwt() and nothing else in schema auth', async () => {
    const rels = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'auth' AND c.relkind IN ('r','p','v','m','S') ORDER BY 1`);
    assert.deepEqual(rels.rows.map((r) => r.relname), ['users']);
    const fns = await db.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'auth' ORDER BY 1`);
    assert.deepEqual(fns.rows.map((r) => r.proname), ['jwt', 'uid']);
  });

  test('has the three roles anon, authenticated, service_role', async () => {
    const r = await db.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY 1`);
    assert.deepEqual(r.rows.map((x) => x.rolname), ['anon', 'authenticated', 'service_role']);
  });

  test('auth.uid() and auth.jwt() read the request claims', async () => {
    const uid = '11111111-1111-4111-8111-111111111111';
    await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false)`);
    assert.equal((await db.query('SELECT auth.uid()::text AS v')).rows[0].v, uid);
    assert.equal((await db.query(`SELECT auth.jwt() ->> 'role' AS v`)).rows[0].v, 'authenticated');
    await db.exec(`SELECT set_config('request.jwt.claims', '', false)`);
    assert.equal((await db.query('SELECT auth.uid() AS v')).rows[0].v, null);
  });
});

describe('one in-process database per call', () => {
  test('two openDb() calls do not share state', async () => {
    const a = await openDb();
    const b = await openDb();
    await a.exec('CREATE TABLE public.only_in_a (id int)');
    const r = await b.query(`SELECT to_regclass('public.only_in_a') AS t`);
    assert.equal(r.rows[0].t, null);
    await a.close();
    await b.close();
  });
});

describe('replay', () => {
  test('lists only top-level .sql files, sorted by name', () => {
    const dir = tree({ '20260102_b.sql': 'select 1', '20260101_a.sql': 'select 1', 'notes.md': 'x' });
    mkdirSync(join(dir, 'data-fixups'));
    writeFileSync(join(dir, 'data-fixups', '20250101_z.sql'), 'select 1');
    assert.deepEqual(listMigrations(dir), ['20260101_a.sql', '20260102_b.sql']);
    rmSync(dir, { recursive: true });
  });

  test('applies in timestamp order', async () => {
    const dir = tree({
      '20260102_b.sql': 'ALTER TABLE public.t ADD COLUMN b int;',
      '20260101_a.sql': 'CREATE TABLE public.t (id int);',
    });
    const db = await openDb();
    const r = await replay(db, { migrationsDir: dir });
    assert.deepEqual(r.applied, ['20260101_a.sql', '20260102_b.sql']);
    assert.deepEqual(r.failed, []);
    await db.close();
    rmSync(dir, { recursive: true });
  });

  test('a failing file that is not listed is reported with its name and its error line', async () => {
    const dir = tree({
      '20260101_a.sql': 'CREATE TABLE public.t (id int);',
      '20260102_bad.sql': 'ALTER TABLE public.missing_table ADD COLUMN x int;',
      '20260103_c.sql': 'CREATE TABLE public.u (id int);',
    });
    const db = await openDb();
    const r = await replay(db, { migrationsDir: dir });
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].file, '20260102_bad.sql');
    assert.match(r.failed[0].error, /missing_table/);
    assert.deepEqual(r.applied, ['20260101_a.sql', '20260103_c.sql']);
    await db.close();
    rmSync(dir, { recursive: true });
  });

  test('a failed file with BEGIN/COMMIT leaves the session usable and rolls back', async () => {
    const dir = tree({
      '20260101_bad.sql': 'BEGIN; CREATE TABLE public.half (id int); ALTER TABLE public.nope ADD COLUMN x int; COMMIT;',
      '20260102_ok.sql': 'CREATE TABLE public.after_it (id int);',
    });
    const db = await openDb();
    const r = await replay(db, { migrationsDir: dir });
    assert.equal(r.failed.length, 1);
    assert.deepEqual(r.applied, ['20260102_ok.sql']);
    assert.equal((await db.query(`SELECT to_regclass('public.half') AS t`)).rows[0].t, null);
    await db.close();
    rmSync(dir, { recursive: true });
  });

  test('a listed skip is not executed and keeps its reason and error line', async () => {
    const dir = tree({
      '20260101_a.sql': 'CREATE TABLE public.t (id int);',
      '20260102_skip.sql': 'CREATE TABLE public.should_not_exist (id int);',
    });
    const skips = [{ file: '20260102_skip.sql', reason: 'needs pgvector', error: 'type "vector" does not exist' }];
    const db = await openDb();
    const r = await replay(db, { migrationsDir: dir, skips });
    assert.deepEqual(r.applied, ['20260101_a.sql']);
    assert.deepEqual(r.skipped, skips);
    assert.deepEqual(r.failed, []);
    assert.equal((await db.query(`SELECT to_regclass('public.should_not_exist') AS t`)).rows[0].t, null);
    await db.close();
    rmSync(dir, { recursive: true });
  });

  test('attemptSkipped: a listed file that still fails stays a skip; one that now succeeds is a stale skip', async () => {
    const dir = tree({
      '20260101_still_bad.sql': 'ALTER TABLE public.nope ADD COLUMN x int;',
      '20260102_now_ok.sql': 'CREATE TABLE public.fine (id int);',
    });
    const skips = [
      { file: '20260101_still_bad.sql', reason: 'r1', error: 'e1' },
      { file: '20260102_now_ok.sql', reason: 'r2', error: 'e2' },
    ];
    const db = await openDb();
    const r = await replay(db, { migrationsDir: dir, skips, attemptSkipped: true });
    assert.deepEqual(r.staleSkips, ['20260102_now_ok.sql']);
    assert.deepEqual(r.skipped.map((s) => s.file), ['20260101_still_bad.sql']);
    assert.deepEqual(r.failed, []);
    await db.close();
    rmSync(dir, { recursive: true });
  });

  test('a skip entry naming a file that does not exist is reported as a stale skip', async () => {
    const dir = tree({ '20260101_a.sql': 'select 1' });
    const db = await openDb();
    const r = await replay(db, { migrationsDir: dir, skips: [{ file: '20260101_gone.sql', reason: 'r', error: 'e' }] });
    assert.deepEqual(r.staleSkips, ['20260101_gone.sql']);
    await db.close();
    rmSync(dir, { recursive: true });
  });
});

describe('list parsers', () => {
  test('parseTableList ignores comments and blanks', () => {
    assert.deepEqual(parseTableList('# c\n\nfoo\n  bar  # trailing\n'), ['foo', 'bar']);
  });
  test('parseNotReplayable reads table | reason | lanes', () => {
    const e = parseNotReplayable('# c\nlive_rooms | creator fails on replay | isolation-suite, generated-inventories\n');
    assert.deepEqual(e, [{ table: 'live_rooms', reason: 'creator fails on replay', lanes: ['isolation-suite', 'generated-inventories'] }]);
  });
  test('parseNotReplayable rejects a line without a reason or lanes', () => {
    assert.throws(() => parseNotReplayable('live_rooms | only a reason'), /live_rooms/);
    assert.throws(() => parseNotReplayable('live_rooms |  | isolation-suite'), /live_rooms/);
  });
});

describe('required-table gate (Amendment 3)', () => {
  let db;
  before(async () => {
    db = await openDb();
    await db.exec('CREATE TABLE public.present_one (id int); CREATE TABLE public.present_two (id int);');
  });
  after(async () => { await db.close(); });

  test('present tables pass; a listed missing table is SKIP with its reason and lanes', async () => {
    const nr = [{ table: 'gone', reason: 'no committed creator', lanes: ['isolation-suite'] }];
    const r = await checkRequiredTables(db, ['present_one', 'gone'], nr);
    assert.deepEqual(r.present, ['present_one']);
    assert.deepEqual(r.skipped, nr);
    assert.deepEqual(r.failures, []);
  });

  test('an unlisted missing required table fails and names the table', async () => {
    const r = await checkRequiredTables(db, ['present_one', 'nowhere'], []);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].table, 'nowhere');
    assert.equal(r.failures[0].kind, 'missing');
    assert.match(r.failures[0].message, /nowhere/);
  });

  test('a listed table that exists is a stale listing and fails', async () => {
    const nr = [{ table: 'present_two', reason: 'old reason', lanes: ['isolation-suite'] }];
    const r = await checkRequiredTables(db, ['present_two'], nr);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].table, 'present_two');
    assert.equal(r.failures[0].kind, 'stale-listing');
    assert.match(r.failures[0].message, /remove/i);
  });

  test('a listing for a table that is not required fails (the list would never be read)', async () => {
    const nr = [{ table: 'not_required', reason: 'r', lanes: ['x'] }];
    const r = await checkRequiredTables(db, ['present_one'], nr);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].kind, 'unrequired-listing');
  });
});

describe('fixtures', () => {
  test('loadFixtures runs *.sql in name order and is safe to run twice', async () => {
    const dir = tree({
      '010_a.sql': 'CREATE TABLE IF NOT EXISTS public.fx (id int PRIMARY KEY, n text); INSERT INTO public.fx VALUES (1, \'a\') ON CONFLICT DO NOTHING;',
      '020_b.sql': 'INSERT INTO public.fx VALUES (2, \'b\') ON CONFLICT DO NOTHING;',
    });
    const db = await openDb();
    const first = await loadFixtures(db, dir);
    assert.deepEqual(first, ['010_a.sql', '020_b.sql']);
    await loadFixtures(db, dir);
    assert.equal((await db.query('SELECT count(*)::int AS c FROM public.fx')).rows[0].c, 2);
    await db.close();
    rmSync(dir, { recursive: true });
  });
});
