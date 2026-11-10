// VTID-05520 (mt-guardrails-r2/local-test-stack-pglite): the D11 local stack, in-process on PGlite.
// One database per call. No Docker, no network, no secret, no production dump (plan.md Amendments 2 and 3).
//
//   openDb()            an empty PGlite database with the stub auth schema (stub-auth.sql)
//   replay()            supabase/migrations/*.sql in timestamp order, with the skips of replay-skip.json
//   checkRequiredTables the gate of Amendment 3 (SKIP a listed missing table, FAIL anything else)
//   loadFixtures()      supabase/tests/fixtures/*.sql, idempotent and synthetic
//   createStack()       all of the above plus the pgTAP-compatible shim; throws StackGateError on a gate failure
//   runTapFile()        run one pgTAP-style .sql file through the shim
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const PATHS = {
  migrations: join(REPO_ROOT, 'supabase', 'migrations'),
  fixtures: join(REPO_ROOT, 'supabase', 'tests', 'fixtures'),
  skips: join(REPO_ROOT, 'supabase', 'tests', 'local-stack', 'replay-skip.json'),
  required: join(REPO_ROOT, 'supabase', 'tests', 'local-stack', 'required-tables.txt'),
  notReplayable: join(REPO_ROOT, 'supabase', 'tests', 'local-stack', 'not-replayable.txt'),
  stubAuth: join(HERE, 'stub-auth.sql'),
  tapShim: join(HERE, 'tap-shim.sql'),
};

export class StackGateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StackGateError';
    Object.assign(this, details);
  }
}

const firstLine = (e) => String((e && e.message) || e).split('\n')[0];

/** A new, empty in-process database with the stub auth schema. PGlite's bundled uuid-ossp, pgcrypto and pg_trgm are available. */
export async function openDb() {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto, pg_trgm } });
  await db.exec(readFileSync(PATHS.stubAuth, 'utf8'));
  return db;
}

/** Top-level `*.sql` files of the migrations directory in name (= timestamp) order. Subdirectories are not migrations. */
export function listMigrations(dir = PATHS.migrations) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.sql'))
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function parseTableList(text) {
  return text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

/** `table | reason | lane, lane` per line; `#` starts a comment. */
export function parseNotReplayable(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    const [table, reason, lanesText] = parts;
    const lanes = (lanesText || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length !== 3 || !table || !reason || !lanes.length) {
      throw new Error(`not-replayable.txt: "${table || line}" needs "table | reason | lanes"`);
    }
    out.push({ table, reason, lanes });
  }
  return out;
}

export const loadRequired = (file = PATHS.required) => parseTableList(readFileSync(file, 'utf8'));
export const loadNotReplayable = (file = PATHS.notReplayable) => parseNotReplayable(readFileSync(file, 'utf8'));
export const loadSkips = (file = PATHS.skips) => JSON.parse(readFileSync(file, 'utf8')).skips;

/**
 * Apply the migrations in order. A skip listed in `skips` is not executed, unless `attemptSkipped` is set: then it is run
 * and must still fail (one that now applies is a stale skip). A file that fails and is not listed is reported in `failed`
 * with its first error line. A failed file is rolled back whole.
 */
export async function replay(db, { migrationsDir = PATHS.migrations, skips = [], attemptSkipped = false } = {}) {
  const files = listMigrations(migrationsDir);
  const onDisk = new Set(files);
  const skipBy = new Map(skips.map((s) => [s.file, s]));
  const result = { applied: [], skipped: [], failed: [], staleSkips: [] };
  for (const s of skips) if (!onDisk.has(s.file)) result.staleSkips.push(s.file);
  for (const file of files) {
    const listed = skipBy.get(file);
    if (listed && !attemptSkipped) {
      result.skipped.push(listed);
      continue;
    }
    let error = null;
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (e) {
      error = firstLine(e);
      try { await db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    }
    try { await db.exec('RESET ALL'); } catch { /* nothing to reset */ }
    if (listed) {
      if (error === null) result.staleSkips.push(file);
      else result.skipped.push(listed);
    } else if (error === null) result.applied.push(file);
    else result.failed.push({ file, error });
  }
  return result;
}

/** Amendment 3: a listed missing table is SKIP; an unlisted missing one, or a listed one that exists, fails. */
export async function checkRequiredTables(db, required, notReplayable) {
  const exists = async (t) => (await db.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r','p')`, [t])).rows.length > 0;
  const listed = new Map(notReplayable.map((e) => [e.table, e]));
  const out = { present: [], skipped: [], failures: [] };
  for (const t of required) {
    const there = await exists(t);
    const entry = listed.get(t);
    if (there && entry) {
      out.failures.push({ table: t, kind: 'stale-listing', message: `table ${t} exists but is listed in not-replayable.txt: the listing is stale, remove its line` });
    } else if (there) {
      out.present.push(t);
    } else if (entry) {
      out.skipped.push(entry);
    } else {
      out.failures.push({ table: t, kind: 'missing', message: `required table ${t} does not exist after the replay and is not listed in not-replayable.txt` });
    }
  }
  for (const e of notReplayable) {
    if (!required.includes(e.table)) {
      out.failures.push({ table: e.table, kind: 'unrequired-listing', message: `table ${e.table} is listed in not-replayable.txt but is not in required-tables.txt` });
    }
  }
  return out;
}

/** Run supabase/tests/fixtures/*.sql in name order. The files must be idempotent. Returns the file names. */
export async function loadFixtures(db, dir = PATHS.fixtures) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      throw new StackGateError(`fixture ${f} failed: ${firstLine(e)}`, { fixture: f });
    }
  }
  return files;
}

export async function loadShim(db, notReplayable = []) {
  await db.exec(readFileSync(PATHS.tapShim, 'utf8'));
  for (const e of notReplayable) {
    await db.query('INSERT INTO tap.not_replayable (table_name, reason, lanes) VALUES ($1, $2, $3) ON CONFLICT (table_name) DO NOTHING',
      [e.table, e.reason, e.lanes.join(', ')]);
  }
}

/**
 * The whole stack: stub auth, replay, the required-table gate, fixtures, shim. Throws StackGateError, naming the failing
 * migration file or table, when the gate fails. `report` carries the numbers.
 */
export async function createStack({
  migrationsDir = PATHS.migrations,
  skips = loadSkips(),
  required = loadRequired(),
  notReplayable = loadNotReplayable(),
  attemptSkipped = false,
  fixtures = true,
  shim = true,
} = {}) {
  const db = await openDb();
  try {
    const rep = await replay(db, { migrationsDir, skips, attemptSkipped });
    if (rep.failed.length) {
      const f = rep.failed[0];
      throw new StackGateError(`migration ${f.file} failed and is not listed in replay-skip.json: ${f.error}` +
        (rep.failed.length > 1 ? ` (+${rep.failed.length - 1} more)` : ''), { replay: rep });
    }
    if (rep.staleSkips.length) {
      throw new StackGateError(`replay-skip.json is stale: ${rep.staleSkips.join(', ')} applies or does not exist, remove its entry`, { replay: rep });
    }
    const tables = await checkRequiredTables(db, required, notReplayable);
    if (tables.failures.length) {
      throw new StackGateError(tables.failures.map((f) => f.message).join('; '), { tables });
    }
    const fixtureFiles = fixtures ? await loadFixtures(db) : [];
    if (shim) await loadShim(db, notReplayable);
    return { db, report: { required, replay: rep, tables, fixtures: fixtureFiles } };
  } catch (e) {
    await db.close();
    throw e;
  }
}

/**
 * Run one pgTAP-style file. Result: { ok, lines, planned, run, failed }. ok is false on any `not ok`, on a plan that does
 * not match the tests run (or is missing), and on a SQL error. `CREATE EXTENSION pgtap` lines are dropped: the shim is the harness.
 */
export async function runTapFile(db, file) {
  const sql = readFileSync(file, 'utf8').replace(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pgtap[^;]*;/gi, '');
  const lines = [];
  let sqlError = false;
  try {
    await db.exec('RESET ROLE; SET search_path = public, tap; UPDATE tap.state SET n = 0, failed = 0, planned = NULL');
    const results = await db.exec(sql);
    for (const r of results) {
      for (const row of r.rows ?? []) {
        const v = Object.values(row)[0];
        if (typeof v === 'string' && /^(ok|not ok|1\.\.|#)/.test(v)) lines.push(v);
      }
    }
  } catch (e) {
    sqlError = true;
    lines.push(`# SQL ERROR: ${firstLine(e)}`);
  } finally {
    try { await db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    try { await db.exec('RESET ROLE; RESET search_path'); } catch { /* ignore */ }
  }
  const planLine = lines.find((l) => /^1\.\.\d+/.test(l));
  const planned = planLine ? Number(planLine.slice(3)) : null;
  const run = lines.filter((l) => /^(not )?ok \d+/.test(l)).length;
  const failed = lines.filter((l) => /^not ok \d+/.test(l)).length;
  const ok = !sqlError && failed === 0 && planned !== null && planned === run && !lines.some((l) => l.startsWith('# Looks like'));
  return { ok, lines, planned, run, failed };
}
