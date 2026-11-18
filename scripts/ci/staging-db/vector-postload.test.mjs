// Staging vector post-load (scripts/aws/staging-db-vector-postload.sql, .sh, staging-db-vector-report.sql).
// The SQL cases replay the file the way staging-db-apply-migration.sh does: split by aurora_sql_split.py, then every
// statement in ONE transaction, on PGlite with pgvector. They need @electric-sql/pglite and run where it is installed
// (STAGING-DB-SCHEMA.yml); without it they are skipped and say so. The static and wrapper cases run everywhere.
// PGlite (WebAssembly) overflows its stack inside PL/pgSQL once vector texts reach ~100 numbers, which a real
// Postgres does not. So the replay scales the three dimensions 768 / 1024 / 1536 down to 3 / 4 / 5 in the SQL text
// (the only place those numbers occur, checked below). Nothing else in the file depends on the dimension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SQL = path.join(ROOT, 'scripts/aws/staging-db-vector-postload.sql');
const REPORT = path.join(ROOT, 'scripts/aws/staging-db-vector-report.sql');
const SH = path.join(ROOT, 'scripts/aws/staging-db-vector-postload.sh');

let PGlite = null;
let vector = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); ({ vector } = await import('@electric-sql/pglite/vector')); } catch { PGlite = null; }
const NEEDS = PGlite ? {} : { skip: '@electric-sql/pglite not installed (runs in STAGING-DB-SCHEMA.yml)' };

// table, column, primary key, pk type, dims, NOT NULL on Supabase (the same list as the SQL and the backfill)
const SCALE = { 768: 3, 1024: 4, 1536: 5 };
const REAL_COLS = [
  ['ai_memory', 'embedding', 'id', 'uuid', 768, false], ['calendar_events', 'embedding', 'id', 'uuid', 1536, false],
  ['dev_agent_memory', 'embedding', 'id', 'uuid', 1024, true], ['feedback_tickets', 'embedding', 'id', 'uuid', 1536, false],
  ['mem_episodes', 'embedding', 'id', 'uuid', 1536, false], ['mem_facts', 'embedding', 'id', 'uuid', 1536, false],
  ['memory_embeddings', 'embedding', 'embedding_id', 'uuid', 768, true], ['memory_facts', 'embedding', 'id', 'uuid', 1024, false],
  ['memory_items', 'embedding', 'id', 'uuid', 1024, false], ['user_intents', 'embedding', 'intent_id', 'uuid', 1536, false],
  ['user_intents', 'embedding_v2', 'intent_id', 'uuid', 1024, false], ['vtid_ledger', 'embedding', 'id', 'text', 1536, false],
  ['vtid_ledger', 'embedding_v2', 'id', 'text', 1024, false],
];
const COLS = REAL_COLS.map(([t, c, pk, pkt, dims, nn]) => [t, c, pk, pkt, SCALE[dims], nn]);
const INDEXES = ['ai_memory_embedding_idx', 'dev_agent_memory_embedding_idx', 'mem_episodes_embedding_hnsw', 'mem_facts_embedding_hnsw', 'idx_mem_emb_vector',
  'idx_memory_facts_embedding_hnsw', 'idx_memory_items_embedding_hnsw', 'user_intents_embedding_hnsw_idx', 'idx_vtid_ledger_embedding_hnsw'];

const statements = ({ scaled = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpl-'));
  const out = path.join(dir, 'plan.json');
  let file = SQL;
  if (scaled) {
    let n = 0;
    const text = fs.readFileSync(SQL, 'utf8').replace(/\b(768|1024|1536)\b/g, (m) => { n += 1; return String(SCALE[m]); });
    assert.equal(n, 26, 'each of the 13 columns names its dimension twice (cast list and end-state check), nothing else');
    file = path.join(dir, 'scaled.sql');
    fs.writeFileSync(file, text);
  }
  const r = spawnSync('python3', [path.join(ROOT, 'scripts/aws/aurora_sql_split.py'), file, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(plan.counts.non_transactional, 0, 'every statement runs inside the one transaction');
  return plan.statements.map((s) => s.sql);
};
const vec = (dims, v = 0.25) => `[${Array(dims).fill(v).join(',')}]`;

/** The staged state after the pre-load and the DMS load: vector columns are text, with complete, truncated,
 *  wrong-dimension and NULL values. Tables get one ordinary column (note) that must survive untouched. */
async function staged({ withExtension = true } = {}) {
  const db = new PGlite({ extensions: { vector } });
  if (withExtension) await db.exec('CREATE EXTENSION vector');
  const tables = new Map();
  for (const [t, c, pk, pkt, dims, nn] of COLS) {
    if (!tables.has(t)) tables.set(t, { pk, pkt, cols: [] });
    tables.get(t).cols.push([c, dims, nn]);
  }
  for (const [t, { pk, pkt, cols }] of tables) {
    await db.exec(`CREATE TABLE public.${t} (${pk} ${pkt} PRIMARY KEY, note text, ${cols.map(([c, , nn]) => `${c} text${nn ? ' NOT NULL' : ''}`).join(', ')})`);
    const rows = [
      ['complete', (d) => vec(d)],
      ['truncated', (d) => vec(d).slice(0, -3)],
      ['wrongdims', (d) => vec(d + 1)],
      ['garbage', () => '[not,a,vector]'],
      ['null', () => null],
    ];
    let i = 0;
    for (const [kind, val] of rows) {
      i += 1;
      const id = pkt === 'uuid' ? `00000000-0000-0000-0000-00000000000${i}` : `VTID-0000${i}`;
      const values = cols.map(([, d, nn]) => (val(d) === null && nn ? vec(d) : val(d)));
      await db.query(`INSERT INTO public.${t} (${pk}, note, ${cols.map(([c]) => c).join(', ')}) VALUES ($1, $2, ${cols.map((_, k) => `$${k + 3}`).join(', ')})`, [id, kind, ...values]);
    }
  }
  return db;
}
async function apply(db) {
  await db.exec('BEGIN');
  try {
    for (const s of statements({ scaled: true })) await db.exec(s);
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}
const one = async (db, q, p = []) => (await db.query(q, p)).rows;
const snapshot = async (db) => {
  const out = {};
  for (const t of new Set(COLS.map((c) => c[0]))) out[t] = await one(db, `SELECT * FROM public.${t} ORDER BY 1`);
  return out;
};

test('static: the post-load never truncates, deletes, reloads or references auth, and runs in one transaction', () => {
  const text = fs.readFileSync(SQL, 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n');
  for (const re of [/\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bUPDATE\s+public\./i, /\bauth\./i, /\bREFERENCES\b/i, /\bCONCURRENTLY\b/i])
    assert.equal(re.test(text), false, `the post-load has no ${re}`);
  assert.equal(statements().length, 15);
  const blocks = fs.readFileSync(REPORT, 'utf8').split(/^-- ;;$/m).map((x) => x.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim());
  assert.equal(blocks.length, 3);
  for (const q of blocks) assert.match(q, /^SELECT\b/);
  const guard = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/staging-prod-ref-guard.mjs'), '--enforce', '--files', SQL, REPORT, SH], { encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
});

test('wrapper: refuses production and a missing cluster before any AWS call; plan is a dry run', () => {
  const env = { ...process.env, PATH: `${fs.mkdtempSync(path.join(os.tmpdir(), 'noaws-'))}:${process.env.PATH}` };
  fs.writeFileSync(path.join(env.PATH.split(':')[0], 'aws'), '#!/bin/sh\necho "aws called" >&2; exit 99\n', { mode: 0o755 });
  for (const args of [['apply', '--cluster', 'vitana-aurora-prod'], ['report', '--cluster', 'vitana-aurora-prod'], ['apply'], ['drop', '--cluster', 'vitana-aurora-staging']]) {
    const r = spawnSync('bash', [SH, ...args], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.doesNotMatch(r.stderr, /aws called/, `${args.join(' ')}: no AWS call`);
  }
  const r = spawnSync('bash', [SH, 'plan', '--cluster', 'vitana-aurora-staging'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /one Data API transaction for 15 statement/);
  assert.match(r.stdout, /Dry run: no AWS call made/);
});

test('post-load: casts every staged column back, keeps every incomplete value, preserves rows and keys, builds the 9 indexes', NEEDS, async () => {
  const db = await staged();
  const before = await snapshot(db);
  await apply(db);
  for (const [t, c, pk, , dims, nn] of COLS) {
    const [{ ty, notnull }] = await one(db, `SELECT format_type(atttypid, atttypmod) AS ty, attnotnull AS notnull FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attname = '${c}'`);
    assert.equal(ty, `vector(${dims})`, `${t}.${c}`);
    if (nn) assert.equal(notnull, false, `${t}.${c}: NOT NULL dropped because it had incomplete values`);
    const rows = await one(db, `SELECT ${pk}::text AS pk, note, ${c}::text AS v FROM public.${t} ORDER BY 1`);
    const orig = before[t];
    assert.equal(rows.length, orig.length, `${t}: row count unchanged`);
    for (const row of rows) {
      const o = orig.find((x) => String(x[pk]) === row.pk);
      assert.ok(o, `${t}: key ${row.pk} preserved`);
      assert.equal(row.note, o.note, `${t}: other columns untouched`);
      if (o[c] === vec(dims)) assert.deepEqual(JSON.parse(row.v), JSON.parse(o[c]), `${t}.${c}: complete vector kept exactly`);
      else assert.equal(row.v, null, `${t}.${c} (${o.note}): becomes NULL in the table`);
    }
    const kept = await one(db, `SELECT pk, raw_text FROM migration_audit.vector_incomplete WHERE table_name = $1 AND column_name = $2 ORDER BY pk`, [t, c]);
    const expected = orig.filter((o) => o[c] !== null && o[c] !== vec(dims)).map((o) => ({ pk: String(o[pk]), raw_text: o[c] })).sort((x, y) => (x.pk < y.pk ? -1 : 1));
    assert.deepEqual(kept, expected, `${t}.${c}: every incomplete value is kept verbatim`);
  }
  for (const i of INDEXES) assert.equal((await one(db, `SELECT count(*)::int AS n FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid WHERE c.relname = $1 AND x.indisvalid`, [i]))[0].n, 1, i);
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'`))[0].n, 0, 'no foreign key created');
});

test('post-load: a second run changes nothing (re-runnable); a column that is already vector is skipped', NEEDS, async () => {
  const db = await staged();
  await db.exec(`ALTER TABLE public.ai_memory ALTER COLUMN embedding TYPE vector(${SCALE[768]}) USING NULL`);
  await apply(db);
  const once = await snapshot(db);
  const keptOnce = await one(db, 'SELECT table_name, column_name, pk, raw_text FROM migration_audit.vector_incomplete ORDER BY 1, 2, 3');
  assert.equal(keptOnce.some((k) => k.table_name === 'ai_memory'), false, 'an already-vector column is not touched');
  await apply(db);
  assert.deepEqual(await snapshot(db), once);
  assert.deepEqual(await one(db, 'SELECT table_name, column_name, pk, raw_text FROM migration_audit.vector_incomplete ORDER BY 1, 2, 3'), keptOnce);
});

test('post-load: NOT NULL is kept when a NOT NULL column has only complete values', NEEDS, async () => {
  const db = await staged();
  await db.exec(`UPDATE public.dev_agent_memory SET embedding = '${vec(SCALE[1024])}'`);
  await apply(db);
  assert.equal((await one(db, `SELECT attnotnull AS nn FROM pg_attribute WHERE attrelid = 'public.dev_agent_memory'::regclass AND attname = 'embedding'`))[0].nn, true);
});

test('post-load: all or nothing — a missing column, a dependent view or a missing extension changes nothing', NEEDS, async () => {
  const cases = [
    ['missing column', async (db) => db.exec('ALTER TABLE public.vtid_ledger DROP COLUMN embedding_v2'), /does not exist/],
    ['dependent view', async (db) => db.exec('CREATE VIEW public.v_mem AS SELECT id, embedding FROM public.mem_facts'), /views depend on vector columns/],
    ['no extension', null, /vector extension is not installed/],
  ];
  for (const [label, mutate, re] of cases) {
    const db = await staged({ withExtension: Boolean(mutate) });
    if (mutate) await mutate(db);
    const before = await snapshot(db);
    await assert.rejects(apply(db), re, label);
    assert.deepEqual(await snapshot(db), before, `${label}: data unchanged`);
    assert.equal((await one(db, `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'migration_audit'`))[0].n, 0, `${label}: rolled back`);
    assert.equal((await one(db, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ai_memory' AND column_name = 'embedding' AND data_type = 'text'`))[0].n, 1, `${label}: still text`);
  }
});

test('report: every SELECT runs after the post-load and shows types, counts, kept values and the 9 indexes', NEEDS, async () => {
  const db = await staged();
  await apply(db);
  const blocks = fs.readFileSync(REPORT, 'utf8').split(/^-- ;;$/m).map((b) => b.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim());
  assert.equal(blocks.length, 3);
  const cols = await one(db, blocks[0]);
  assert.equal(cols.length, 13);
  for (const r of cols) {
    const [, , , , dims] = COLS.find(([t, c]) => t === r.table_name && c === r.column_name);
    assert.equal(r.column_type, `vector(${dims})`);
    assert.equal(Number(r.row_count), 5);
    assert.equal(Number(r.stashed), 3);
    assert.equal(Number(r.stashed_still_null), 3, 'before the backfill, every kept value is still NULL in the table');
  }
  assert.deepEqual((await one(db, blocks[1])).map((r) => r.index_name).sort(), [...INDEXES].sort());
  assert.equal(Number((await one(db, blocks[2]))[0].foreign_keys_to_auth_schema), 0);
});

const AFTER = path.join(ROOT, 'scripts/aws/staging-db-after-load.sh');
test('after-load sequence: refuses production before any AWS call; --plan shows the three steps in order with their statement counts', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'noaws-'));
  fs.writeFileSync(path.join(bin, 'aws'), '#!/bin/sh\necho "aws called" >&2; exit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const args of [['--cluster', 'vitana-aurora-prod'], [], ['--cluster', 'vitana-aurora-staging', '--apply-now']]) {
    const r = spawnSync('bash', [AFTER, ...args], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.doesNotMatch(r.stderr, /aws called/);
  }
  const r = spawnSync('bash', [AFTER, '--cluster', 'vitana-aurora-staging', '--plan'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const steps = [...r.stdout.matchAll(/^== (\d)\/3 (.+) \((.+)\)$/gm)].map((m) => m[3]);
  assert.deepEqual(steps, ['staging-db-vector-postload.sql', 'aurora-cutover-recreate-foreign-keys.sql', 'aurora-cutover-schema-sync-views.sql']);
  assert.deepEqual([...r.stdout.matchAll(/one Data API transaction for (\d+) statement/g)].map((m) => Number(m[1])), [15, 360, 20]);
  assert.match(r.stdout, /ALL DONE: 3 step\(s\) on vitana-aurora-staging \(plan only, no AWS call\)/);
  assert.doesNotMatch(r.stderr, /aws called/);
});

test('after-load sequence: the reused production SQL creates no foreign key to auth and changes no data', () => {
  for (const f of ['aurora-cutover-recreate-foreign-keys.sql', 'aurora-cutover-schema-sync-views.sql']) {
    const live = fs.readFileSync(path.join(ROOT, 'scripts/aws', f), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    for (const re of [/\bauth\./i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+TABLE\b/i, /\bUPDATE\s+(public\.)?\w+\s+SET\b/i]) assert.equal(re.test(live), false, `${f}: no ${re}`);
  }
  const guard = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/staging-prod-ref-guard.mjs'), '--enforce', '--files', AFTER], { encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout);
});
