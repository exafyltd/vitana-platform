#!/usr/bin/env node
/**
 * VTID-03486 — assert that what the migration files declare actually exists in
 * the database.
 *
 * WHY THIS IS NOT A VERSION-MATCH CHECK
 * -------------------------------------
 * The obvious implementation — "every file in supabase/migrations/ has a row in
 * supabase_migrations.schema_migrations" — does not work on this project, and
 * shipping it would have produced a check that is red on day one and therefore
 * ignored (the same fate as the ok:false nobody watched in VTID-03480).
 *
 * Measured 2026-08-04 against production (inmkhvwdcuyhnxkgfvsb):
 *   - 459 migration files -> 377 distinct version prefixes
 *   - 330 rows in supabase_migrations.schema_migrations
 *   - overlap between the two sets: 2
 *
 * The sets are near-disjoint because migrations here reach the database by
 * several routes (dashboard SQL editor, MCP apply_migration, direct psql), and
 * most of those record a *fresh* timestamp rather than the file's own version.
 * Applying 20260606000000_DEV_COMHU_0503_orb_session_state.sql on 2026-08-03,
 * for instance, was recorded as version 20260803202122. Version bookkeeping
 * here is simply not a reliable record of what ran.
 *
 * What IS reliable is the database's own schema. So this check asserts the
 * thing we actually care about and that actually caught VTID-03480: if a
 * migration says CREATE TABLE x, then table x had better exist.
 *
 * BASELINE
 * --------
 * There is a large pre-existing backlog (~105 declared-but-absent tables as of
 * 2026-08-04). Failing on all of it immediately would make the check noise, so
 * known drift is recorded in migration-drift-baseline.json and the check fails
 * only on drift that is NEW relative to that file. The baseline is a visible
 * backlog, not an amnesty — shrink it.
 *
 * Usage:
 *   node scripts/ci/check-migration-drift.cjs --live <file-with-one-table-per-line>
 *   node scripts/ci/check-migration-drift.cjs --live live.txt --update-baseline
 */

const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const HERE = __dirname;
const REPO_ROOT = join(HERE, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const BASELINE_PATH = join(HERE, 'migration-drift-baseline.json');

/**
 * Strip SQL comments so that commented-out DDL and prose mentioning
 * "create table" cannot register as a declaration.
 */
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function unquote(ident) {
  return ident.replace(/^"(.*)"$/, '$1').toLowerCase();
}

/**
 * Extract table declarations and removals from one migration's SQL.
 *
 * Only `public` (or unqualified) tables are considered — other schemas are out
 * of scope for this check and would produce false positives against a
 * public-only inventory.
 */
function parseMigrationSql(sql) {
  const clean = stripSqlComments(sql);
  const created = new Set();
  const dropped = new Set();

  const ident = '(?:"[^"]+"|[a-zA-Z0-9_]+)';
  // Anchored at a statement boundary (start of input or after ';') so that
  // "... REFERENCES create table"-style prose can't match.
  const createRe = new RegExp(
    `(?:^|;)\\s*create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:(${ident})\\s*\\.\\s*)?(${ident})`,
    'gi',
  );
  const dropRe = new RegExp(
    `(?:^|;)\\s*drop\\s+table\\s+(?:if\\s+exists\\s+)?(?:(${ident})\\s*\\.\\s*)?(${ident})`,
    'gi',
  );
  const renameRe = new RegExp(
    `(?:^|;)\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:(${ident})\\s*\\.\\s*)?(${ident})\\s+rename\\s+to\\s+(${ident})`,
    'gi',
  );

  for (const m of clean.matchAll(createRe)) {
    const schema = m[1] ? unquote(m[1]) : 'public';
    if (schema !== 'public') continue;
    created.add(unquote(m[2]));
  }
  for (const m of clean.matchAll(dropRe)) {
    const schema = m[1] ? unquote(m[1]) : 'public';
    if (schema !== 'public') continue;
    dropped.add(unquote(m[2]));
  }
  // A renamed table no longer exists under its old name — treat the old name as
  // removed and the new one as declared.
  for (const m of clean.matchAll(renameRe)) {
    const schema = m[1] ? unquote(m[1]) : 'public';
    if (schema !== 'public') continue;
    dropped.add(unquote(m[2]));
    created.add(unquote(m[3]));
  }

  return { created, dropped };
}

/**
 * Walk every migration in filename order, tracking the net set of tables the
 * repo believes should exist. Order matters: a table created early and dropped
 * later must not be reported as missing.
 */
function collectDeclaredTables(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const expected = new Map(); // table -> file that last declared it
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const { created, dropped } = parseMigrationSql(sql);
    for (const t of created) expected.set(t, file);
    for (const t of dropped) expected.delete(t);
  }
  return expected;
}

function loadBaseline() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return new Set(raw.known_missing_tables || []);
  } catch {
    return new Set();
  }
}

function main() {
  const args = process.argv.slice(2);
  const liveIdx = args.indexOf('--live');
  const updateBaseline = args.includes('--update-baseline');
  if (liveIdx === -1 || !args[liveIdx + 1]) {
    console.error('usage: check-migration-drift.cjs --live <file> [--update-baseline]');
    process.exit(2);
  }

  const live = new Set(
    readFileSync(args[liveIdx + 1], 'utf8')
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (live.size === 0) {
    console.error('::error::Live table list is empty — refusing to run. Every table would look missing.');
    process.exit(2);
  }

  const expected = collectDeclaredTables();
  const missing = [...expected.keys()].filter((t) => !live.has(t)).sort();

  if (updateBaseline) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          _comment:
            'VTID-03486. Tables declared by supabase/migrations/**.sql that do NOT exist in production. ' +
            'This is pre-existing drift recorded so the CI check can fail only on NEW drift. ' +
            'It is a backlog to shrink, not an amnesty — every entry is a migration whose SQL never reached the database.',
          generated_at: new Date().toISOString().slice(0, 10),
          count: missing.length,
          known_missing_tables: missing,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Baseline written: ${missing.length} known-missing tables.`);
    return;
  }

  const baseline = loadBaseline();
  const newlyMissing = missing.filter((t) => !baseline.has(t));
  const recovered = [...baseline].filter((t) => live.has(t)).sort();

  console.log(`Declared by migrations: ${expected.size}`);
  console.log(`Live in database:       ${live.size}`);
  console.log(`Missing (total):        ${missing.length}`);
  console.log(`Missing (baselined):    ${missing.length - newlyMissing.length}`);
  console.log(`Missing (NEW):          ${newlyMissing.length}`);

  if (recovered.length > 0) {
    console.log(
      `\n${recovered.length} baselined table(s) now exist — please refresh the baseline ` +
        `(node scripts/ci/check-migration-drift.cjs --live <file> --update-baseline):`,
    );
    for (const t of recovered) console.log(`  + ${t}`);
  }

  if (newlyMissing.length > 0) {
    console.error('');
    for (const t of newlyMissing) {
      console.error(
        `::error::Migration drift: table "${t}" is declared in ${expected.get(t)} but does not exist in the database. ` +
          'The migration was authored but never applied — this is the VTID-03480 failure mode. ' +
          'Apply it, or drop the CREATE from the migration if it was superseded.',
      );
    }
    process.exit(1);
  }

  console.log('\nNo new migration drift.');
}

// Only run when invoked directly, so the parser can be unit-tested.
if (require.main === module) {
  main();
}

module.exports = { stripSqlComments, parseMigrationSql, collectDeclaredTables };
