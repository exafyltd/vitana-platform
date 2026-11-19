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
  assert.equal(statements().length, 16);
  const blocks = fs.readFileSync(REPORT, 'utf8').split(/^-- ;;$/m).map((x) => x.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim());
  assert.equal(blocks.length, 5);
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
  assert.match(r.stdout, /one Data API transaction for 16 statement/);
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
  await db.exec(`CREATE SCHEMA IF NOT EXISTS migration_audit; CREATE TABLE IF NOT EXISTS migration_audit.saved_foreign_keys (references_auth boolean, restored_at timestamptz); CREATE TABLE IF NOT EXISTS migration_audit.saved_views (restored_at timestamptz); CREATE TABLE IF NOT EXISTS migration_audit.saved_indexes (restored_at timestamptz)`);
  const blocks = fs.readFileSync(REPORT, 'utf8').split(/^-- ;;$/m).map((b) => b.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim());
  assert.equal(blocks.length, 5);
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

const MIG = path.join(ROOT, 'scripts/aws/staging-db-migration.sh');
const PRE = path.join(ROOT, 'scripts/aws/staging-db-vector-preload.sql');
const RESTORE = path.join(ROOT, 'scripts/aws/staging-db-restore-saved.sql');
const split = (file) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vpl-')), 'plan.json');
  const r = spawnSync('python3', [path.join(ROOT, 'scripts/aws/aurora_sql_split.py'), file, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(plan.counts.non_transactional, 0);
  return plan.statements.map((x) => x.sql);
};
async function applyFile(db, file) {
  await db.exec('BEGIN');
  try {
    for (const st of (file === SQL ? statements({ scaled: true }) : split(file))) await db.exec(st);
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

test('migration sequence: refuses production before any AWS call; --plan shows pre-load, then post-load in order', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'noaws-'));
  fs.writeFileSync(path.join(bin, 'aws'), '#!/bin/sh\necho "aws called" >&2; exit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const args of [['pre-load', '--cluster', 'vitana-aurora-prod'], ['post-load', '--cluster', 'vitana-aurora-prod'], ['post-load'], ['load', '--cluster', 'vitana-aurora-staging']]) {
    const r = spawnSync('bash', [MIG, ...args], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.doesNotMatch(r.stderr, /aws called/);
  }
  const plan = (mode) => spawnSync('bash', [MIG, mode, '--cluster', 'vitana-aurora-staging', '--plan'], { encoding: 'utf8', env });
  const pre = plan('pre-load');
  assert.equal(pre.status, 0, pre.stdout + pre.stderr);
  assert.deepEqual([...pre.stdout.matchAll(/^== pre-load \d\/1 .+ \((.+)\)$/gm)].map((m) => m[1]), ['staging-db-vector-preload.sql']);
  const post = plan('post-load');
  assert.equal(post.status, 0, post.stdout + post.stderr);
  assert.deepEqual([...post.stdout.matchAll(/^== post-load \d\/2 .+ \((.+)\)$/gm)].map((m) => m[1]), ['staging-db-vector-postload.sql', 'staging-db-restore-saved.sql']);
  assert.deepEqual([...(pre.stdout + post.stdout).matchAll(/one Data API transaction for (\d+) statement/g)].map((m) => Number(m[1])), [10, 16, 6]);
  for (const r of [pre, post]) assert.doesNotMatch(r.stderr, /aws called/);
  for (const f of [PRE, RESTORE, MIG]) {
    const live = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('--') && !l.startsWith('#')).join('\n');
    for (const re of [/\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bUPDATE\s+public\./i, /\bCASCADE\b/i]) assert.equal(re.test(live), false, `${path.basename(f)}: no ${re}`);
  }
  const guard = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/staging-prod-ref-guard.mjs'), '--enforce', '--files', MIG, PRE, RESTORE], { encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout);
});

/** The schema the VTID-05803 path builds: native vector columns and indexes, public foreign keys, a public -> auth.users
 *  foreign key on a stub, views (one on another) with options, grants and a comment, a materialized view. */
async function restored() {
  const db = new PGlite({ extensions: { vector } });
  await db.exec('CREATE EXTENSION vector');
  await db.exec('CREATE ROLE authenticated');
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY)');
  await db.exec('CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, name text)');
  const tables = new Map();
  for (const [t, c, pk, pkt, dims] of COLS) {
    if (!tables.has(t)) tables.set(t, { pk, pkt, cols: [] });
    tables.get(t).cols.push([c, dims]);
  }
  for (const [t, { pk, pkt, cols }] of tables) {
    await db.exec(`CREATE TABLE public.${t} (${pk} ${pkt} PRIMARY KEY, note text, tenant_id uuid, ${cols.map(([c, d]) => `${c} vector(${d})`).join(', ')})`);
    await db.exec(`ALTER TABLE public.${t} ADD CONSTRAINT ${t}_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE CASCADE`);
  }
  await db.exec('ALTER TABLE public.memory_items ADD COLUMN user_id uuid, ADD CONSTRAINT memory_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)');
  for (const i of INDEXES) {
    const [t, c] = { ai_memory_embedding_idx: ['ai_memory', 'embedding'], dev_agent_memory_embedding_idx: ['dev_agent_memory', 'embedding'], mem_episodes_embedding_hnsw: ['mem_episodes', 'embedding'], mem_facts_embedding_hnsw: ['mem_facts', 'embedding'], idx_mem_emb_vector: ['memory_embeddings', 'embedding'], idx_memory_facts_embedding_hnsw: ['memory_facts', 'embedding'], idx_memory_items_embedding_hnsw: ['memory_items', 'embedding'], user_intents_embedding_hnsw_idx: ['user_intents', 'embedding'], idx_vtid_ledger_embedding_hnsw: ['vtid_ledger', 'embedding'] }[i];
    await db.exec(`CREATE INDEX ${i} ON public.${t} USING ${/ivf|idx_mem_emb/.test(i) ? 'ivfflat' : 'hnsw'} (${c} vector_cosine_ops)`);
  }
  await db.exec(`CREATE VIEW public.v_facts WITH (security_invoker = true) AS SELECT id, note, embedding FROM public.mem_facts WHERE note IS NOT NULL`);
  await db.exec(`CREATE VIEW public.v_facts_notes AS SELECT id, note FROM public.v_facts`);
  await db.exec(`GRANT SELECT ON public.v_facts, public.v_facts_notes TO authenticated`);
  await db.exec(`COMMENT ON VIEW public.v_facts IS 'facts with an embedding'`);
  await db.exec(`CREATE MATERIALIZED VIEW public.mv_ledger AS SELECT id, embedding_v2 FROM public.vtid_ledger`);
  await db.exec(`CREATE VIEW public.v_tenants AS SELECT tenant_id, name FROM public.tenants`);
  await db.exec(`INSERT INTO public.tenants VALUES ('11111111-1111-1111-1111-111111111111', 'staging tenant')`);
  return db;
}
const catalog = async (db) => ({
  fks: await one(db, `SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 2`),
  views: await one(db, `SELECT c.relname, c.relkind::text AS kind, pg_get_viewdef(c.oid) AS def, c.reloptions, c.relacl::text AS acl, obj_description(c.oid, 'pg_class') AS cmt FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') ORDER BY 1`),
  idx: await one(db, `SELECT indexrelid::regclass::text AS i, pg_get_indexdef(indexrelid) AS def FROM pg_index x JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT x.indisprimary ORDER BY 1`),
});
/** What DMS does with TRUNCATE_BEFORE_LOAD: empty every table, then insert the source rows, vectors as (possibly truncated) text. */
async function dmsLoad(db) {
  for (const t of ['tenants', ...new Set(COLS.map((c) => c[0]))]) await db.exec(`TRUNCATE public.${t}`);
  await db.exec(`INSERT INTO public.tenants VALUES ('11111111-1111-1111-1111-111111111111', 'staging tenant')`);
  for (const [t, c, pk, pkt, dims] of COLS) {
    for (const [k, v] of [[1, vec(dims)], [2, vec(dims).slice(0, -3)]]) {
      const id = pkt === 'uuid' ? `00000000-0000-0000-0000-00000000000${k}` : `VTID-0000${k}`;
      await db.query(`INSERT INTO public.${t} (${pk}, note, tenant_id, ${c}) VALUES ($1, 'loaded', '11111111-1111-1111-1111-111111111111', $2) ON CONFLICT (${pk}) DO UPDATE SET ${c} = EXCLUDED.${c}`, [id, v]);
    }
  }
}

test('full staging cycle: pre-load lets the DMS truncate-and-load run; post-load restores exactly what was there, without the public -> auth FK', NEEDS, async () => {
  const db = await restored();
  const before = await catalog(db);
  assert.equal(before.fks.filter((f) => /auth\.users/.test(f.def)).length, 1, 'fixture has one public -> auth.users FK');
  await assert.rejects(db.exec('TRUNCATE public.tenants'), /foreign key|referenced/i, 'without the pre-load the DMS truncate fails');
  await applyFile(db, PRE);
  const staged = await one(db, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('embedding', 'embedding_v2') AND data_type = 'text'`);
  assert.equal(staged[0].n, 13);
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'`))[0].n, 0);
  assert.deepEqual((await one(db, `SELECT relname FROM pg_class WHERE relname IN ('v_facts', 'v_facts_notes', 'mv_ledger', 'v_tenants') ORDER BY 1`)).map((r) => r.relname), ['v_tenants'], 'only views on vector columns are dropped');
  await applyFile(db, PRE); // re-runnable
  await dmsLoad(db);
  await applyFile(db, SQL);
  await applyFile(db, RESTORE);
  const after = await catalog(db);
  assert.deepEqual(after.fks.map((f) => [f.t, f.conname]), before.fks.filter((f) => !/auth\.users/.test(f.def)).map((f) => [f.t, f.conname]), 'every FK back, except the public -> auth one');
  for (const f of after.fks) assert.equal(f.def, before.fks.find((b) => b.conname === f.conname).def + ' NOT VALID', `${f.conname}: same definition, NOT VALID`);
  assert.deepEqual(after.views, before.views, 'views, options, grants and comments identical');
  assert.deepEqual(after.idx, before.idx, 'indexes identical');
  const saved = await one(db, `SELECT constraint_name, references_auth, restored_at IS NOT NULL AS restored FROM migration_audit.saved_foreign_keys WHERE references_auth`);
  assert.deepEqual(saved, [{ constraint_name: 'memory_items_user_id_fkey', references_auth: true, restored: false }], 'the R2 FK is recorded, never restored');
  for (const [t, c, pk] of COLS) {
    const rows = await one(db, `SELECT ${pk}::text AS k, ${c} IS NULL AS isnull FROM public.${t} ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.isnull), [false, true], `${t}.${c}: complete vector cast, truncated one NULL`);
  }
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM migration_audit.vector_incomplete`))[0].n, 13, 'each truncated value kept');
  const again = await catalog(db);
  await applyFile(db, SQL);
  await applyFile(db, RESTORE);
  assert.deepEqual(await catalog(db), again, 'post-load is re-runnable');
  const blocks = fs.readFileSync(REPORT, 'utf8').split(/^-- ;;$/m).map((b) => b.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim());
  assert.equal(blocks.length, 5);
  const saved2 = Object.fromEntries((await one(db, blocks[3])).map((r) => [r.object, r]));
  assert.equal(Number(saved2.foreign_keys.excluded_auth_r2), 1);
  assert.equal(Number(saved2.foreign_keys.pending), 0);
  assert.equal(Number(saved2.views.saved), 3);
  assert.equal(Number(saved2.views.pending), 0);
  assert.equal(Number((await one(db, blocks[2]))[0].foreign_keys_to_auth_schema), 0);
  assert.equal(Number((await one(db, blocks[4]))[0].public_fks_not_valid), before.fks.length - 1);
});

test('restore: a public -> auth FK the pre-load never saw (migration replay) is recorded and dropped', NEEDS, async () => {
  const db = await restored();
  await applyFile(db, PRE);
  await db.exec('ALTER TABLE public.ai_memory ADD COLUMN owner_id uuid, ADD CONSTRAINT ai_memory_owner_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id)');
  await applyFile(db, SQL);
  await applyFile(db, RESTORE);
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE c.contype = 'f' AND n.nspname = 'auth'`))[0].n, 0);
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM migration_audit.saved_foreign_keys WHERE references_auth`))[0].n, 2);
});

test('pre-load and restore: all or nothing — a policy on a vector column stops the pre-load; restore refuses before the vector post-load', NEEDS, async () => {
  const db = await restored();
  await db.exec(`ALTER TABLE public.mem_facts ENABLE ROW LEVEL SECURITY; CREATE POLICY p_emb ON public.mem_facts USING (embedding IS NOT NULL)`);
  const before = await catalog(db);
  await assert.rejects(applyFile(db, PRE), /policy p_emb on mem_facts\.embedding/);
  assert.deepEqual(await catalog(db), before, 'nothing changed');
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'migration_audit'`))[0].n, 0);
  const db2 = await restored();
  await applyFile(db2, PRE);
  await assert.rejects(applyFile(db2, RESTORE), /run the vector post-load first/);
  assert.equal((await one(db2, `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'`))[0].n, 0, 'nothing restored early');
});

// ── VTID-05803 package path: load-stages.sh (psql from the package task) ─────────────────────────────────────────────
const PKG = path.join(ROOT, 'docs/validation/VTID-05803/schema-restore-package');
const STAGES = path.join(PKG, 'load-stages.sh');
const WRITER = 'vitana-aurora-staging.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com';
function fakePsql({ failOn = null } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'psql-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'psql'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\necho "psql saw $3" >&2\n${failOn ? `case "$*" in *${failOn}*) exit 3;; esac\n` : ''}exit 0\n`, { mode: 0o755 });
  return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}
const runStages = (stage, uri, psql) => spawnSync('bash', [STAGES], { encoding: 'utf8', env: { ...process.env, PATH: `${psql.bin}:${process.env.PATH}`, STAGE: stage, STAGING_PGURI: uri } });
const URI = `postgresql://vitana_staging_admin:s3cr3t-pw@${WRITER}:5432/vitana?sslmode=require`;

test('package load-stages: refuses production, other hosts and unknown stages before psql runs', () => {
  for (const [stage, uri] of [['pre-load', URI.replace(WRITER, 'vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com')], ['post-load', URI.replace(WRITER, 'db.inmkhvwdcuyhnxkgfvsb.supabase.co')], ['post-load', URI.replace('/vitana?', '/postgres?')], ['post-load', URI.replace('sslmode=require', 'sslmode=disable')], ['load', URI], ['post-load', '']]) {
    const p = fakePsql();
    const r = runStages(stage, uri, p);
    assert.equal(r.status, 1, `${stage} ${uri}: ${r.stderr}`);
    assert.deepEqual(p.calls(), [], 'psql never ran');
  }
});

test('package load-stages: pre-load, then post-load in order, each file one transaction; a failure stops and exits 2; secrets redacted', () => {
  const pre = fakePsql();
  let r = runStages('pre-load', URI, pre);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(pre.calls().length, 1);
  assert.match(pre.calls()[0], /-v ON_ERROR_STOP=1 --single-transaction -f \S+\/scripts\/aws\/staging-db-vector-preload\.sql$/);
  const post = fakePsql();
  r = runStages('post-load', URI, post);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(post.calls().map((c) => c.split('/').pop()), ['staging-db-vector-postload.sql', 'staging-db-restore-saved.sql']);
  for (const c of post.calls()) assert.match(c, /--single-transaction/);
  const bad = fakePsql({ failOn: 'staging-db-vector-postload.sql' });
  r = runStages('post-load', URI, bad);
  assert.equal(r.status, 2);
  assert.equal(bad.calls().length, 1, 'restore-saved does not run after a failed post-load');
  for (const out of [r.stdout, r.stderr]) { assert.doesNotMatch(out, /s3cr3t-pw/); assert.doesNotMatch(out, new RegExp(URI.replace(/[.?]/g, '\\$&'))); }
  assert.match(r.stderr, /<STAGING_PGURI>/);
});

test('package load-stages: report runs each SELECT inside a read-only transaction that is rolled back', () => {
  const p = fakePsql();
  const r = runStages('report', URI, p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(p.calls().length, 5);
  for (const c of p.calls()) assert.match(c, /-c BEGIN READ ONLY -f \S+q\d\.sql -c ROLLBACK$/);
  fs.rmSync(path.join(PKG, 'load-report.out'), { force: true });
});

test('package: SHA256SUMS covers the stage runner and the four SQL files it runs, and every checksum matches', () => {
  const sums = fs.readFileSync(path.join(PKG, 'SHA256SUMS'), 'utf8');
  for (const f of ['load-stages.sh', 'run-staging.sh', '../../../../scripts/aws/staging-db-load-probe.sql', '../../../../scripts/aws/staging-db-vector-preload.sql', '../../../../scripts/aws/staging-db-vector-postload.sql', '../../../../scripts/aws/staging-db-restore-saved.sql', '../../../../scripts/aws/staging-db-vector-report.sql'])
    assert.match(sums, new RegExp(`  ${f.replace(/[.]/g, '\\.')}$`, 'm'), f);
  const r = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: PKG, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const run = fs.readFileSync(path.join(PKG, 'run-staging.sh'), 'utf8');
  assert.match(run, /pre-load\|post-load\|report\)/);
  assert.ok(run.indexOf('checksums-verified') < run.indexOf('load-stages.sh'), 'stages run only after the commit and checksum checks');
});

// ── CI runner on the authorized staging execution path (vtid-05803-load-stages.gitlab-ci.yml) ───────────────────────
const GEN = path.join(ROOT, 'scripts/aws/staging-db-load-stage-ci.mjs');
const { STAGES: LS_STAGES, payload: lsPayload, strip: lsStrip, CONTAINER_CMD, OVERRIDE_LIMIT, OUT_FILE: LS_YAML } = await import(GEN);

test('CI runner: the committed job is generated from this commit (--check), refuses non-main/non-api runs, and every override fits ECS', () => {
  const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const y = fs.readFileSync(LS_YAML, 'utf8');
  assert.match(y, /- if: \$CI_COMMIT_BRANCH == "main" && \$CI_PIPELINE_SOURCE =~ \/\^\(api\|web\)\$\/ && \$VTID05803_LOAD_STAGE =~ \/\^\(probe\|pre-load\|post-load-1\|post-load-2\|report\)\$\//);
  assert.match(y, /LS_TD: vitana-aurora-staging-migrate:2\n/);
  assert.match(y, /\*prod\*\) fin 3 "task definition PGHOST names production"/);
  assert.doesNotMatch(y, /vitana-aurora-prod|inmkhvwdcuyhnxkgfvsb|AWS_PROD_ROLE_ARN/);
  for (const s of Object.keys(LS_STAGES)) {
    const p = lsPayload(s);
    const env = [{ name: 'LP', value: p.b64 }, { name: 'LPS', value: p.sha256 }, { name: 'STAGE', value: s }, { name: 'OUT', value: 's3://vitana-code-index/vtid-05803/staging/runs/20261119T000000Z-k2-load-post-load-1' }];
    const bytes = JSON.stringify({ containerOverrides: [{ name: 'migrate', command: ['bash', '-c', CONTAINER_CMD], environment: env }] }).length;
    assert.ok(bytes < OVERRIDE_LIMIT - 200, `${s}: override ${bytes} bytes`);
    assert.ok(y.includes(`LPS_${s.replace(/-/g, '_')}: "${p.sha256}"`), `${s}: pinned sha256 in the job`);
  }
});

function runContainer(stage, { psqlLine = null, failOn = null } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'ctr-'));
  const bin = path.join(w, 'bin'); fs.mkdirSync(bin);
  const log = path.join(w, 'calls.log');
  fs.writeFileSync(path.join(bin, 'apt-get'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\necho "aws $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'psql'), `#!/bin/bash\nprintf 'psql %s\\n' "$*" >> "${log}"\n${failOn ? `case "$*" in *${failOn}*) exit 3;; esac\n` : ''}${psqlLine ? `echo '${psqlLine}'\n` : ''}exit 0\n`, { mode: 0o755 });
  const p = lsPayload(stage);
  const cmd = CONTAINER_CMD.replace('mkdir -p /w && cd /w', `mkdir -p ${w}/w && cd ${w}/w`);
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, LP: p.b64, LPS: p.sha256, STAGE: stage, OUT: 's3://b/runs/x', PGUSER: 'vitana_staging_admin', PGPASSWORD: 'p@ss:w0rd', PGHOST: WRITER } });
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [], dir: path.join(w, 'w') };
}

test('CI runner container: payload decodes to the repository files (comments stripped only), runs the stage through load-stages.sh, uploads the output', () => {
  for (const s of Object.keys(LS_STAGES)) {
    const r = runContainer(s, { psqlLine: s === 'probe' ? 'PROBE|701|13|0|359|0|f|1|0' : null });
    assert.equal(r.status, 0, `${s}: ${r.stdout}${r.stderr}`);
    for (const f of ['docs/validation/VTID-05803/schema-restore-package/load-stages.sh', ...LS_STAGES[s]]) assert.equal(fs.readFileSync(path.join(r.dir, f), 'utf8'), lsStrip(f), `${s}: ${f}`);
    const psql = r.calls.filter((c) => c.startsWith('psql'));
    if (['pre-load', 'post-load-1', 'post-load-2'].includes(s)) {
      assert.equal(psql.length, 1);
      assert.match(psql[0], new RegExp(`--single-transaction -f \\S+/${LS_STAGES[s][0].split('/').pop().replace(/\./g, '\\.')}$`));
    }
    assert.ok(r.calls.some((c) => c === `aws s3 cp out.txt s3://b/runs/x/${s}.txt --only-show-errors`), `${s}: output uploaded`);
    assert.doesNotMatch(r.stdout + r.stderr, /p@ss:w0rd|p%40ss%3Aw0rd/, 'password never printed');
  }
  assert.match(runContainer('probe', { psqlLine: 'PROBE|701|13|0|359|0|f|1|0' }).stdout, /PROBE ready_for=pre-load/);
});

test('CI runner container: probe says restore (exit 10) on the 6-table seed; a failed SQL stage exits 2; a tampered payload is refused (22)', () => {
  const seed = runContainer('probe', { psqlLine: 'PROBE|6|0|0|0|0|f|0|2' });
  assert.equal(seed.status, 10);
  assert.match(seed.stdout, /PROBE ready_for=restore/);
  assert.equal(runContainer('probe', { psqlLine: 'PROBE|701|0|13|0|0|t|1|0' }).stdout.match(/ready_for=(\w[\w-]*)/)[1], 'dms');
  assert.equal(runContainer('probe', { psqlLine: 'PROBE|701|0|13|0|0|t|1|5000' }).stdout.match(/ready_for=(\w[\w-]*)/)[1], 'post-load');
  assert.equal(runContainer('probe', { psqlLine: 'PROBE|701|13|0|359|0|t|1|5000' }).stdout.match(/ready_for=(\w[\w-]*)/)[1], 'done');
  assert.equal(runContainer('post-load-1', { failOn: 'staging-db-vector-postload.sql' }).status, 2);
  const p = lsPayload('pre-load');
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'ctr-'));
  const r = spawnSync('bash', ['-c', CONTAINER_CMD.replace('mkdir -p /w && cd /w', `mkdir -p ${w}/w && cd ${w}/w`).replace(/apt-get update[^;]*;/, 'true;')], { encoding: 'utf8', env: { PATH: process.env.PATH, LP: p.b64, LPS: '0'.repeat(64), STAGE: 'pre-load', OUT: 's3://b/x', PGUSER: 'u', PGPASSWORD: 'p', PGHOST: WRITER } });
  assert.equal(r.status, 22);
});
