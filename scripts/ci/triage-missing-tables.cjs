#!/usr/bin/env node
/**
 * VTID-03511 — triage the declared-but-absent tables from the VTID-03486
 * drift baseline.
 *
 * WHY A SCRIPT AND NOT A SPREADSHEET
 * ----------------------------------
 * The 2026-08-05 probe established that these are NOT simply un-run migrations
 * (see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 2). At least one fails
 * to apply because `CREATE TABLE IF NOT EXISTS` silently skips a table that
 * exists with a diverged schema. So each entry needs evidence, and the evidence
 * changes as migrations land — a checked-in verdict list would rot immediately.
 *
 * WHAT IT DOES
 *   1. Maps every missing table to the migration file that declares it.
 *   2. Groups by file — migrations are the unit that applies, not tables.
 *   3. Cross-references live CODE usage (which tables are actually queried,
 *      and how often) from aurora-migration-inventory.cjs.
 *   4. Flags files that ALSO declare a table which already exists — the
 *      IF-NOT-EXISTS masking hazard that makes a migration unappliable.
 *   5. Emits a recommended disposition per migration file.
 *
 * DISPOSITIONS
 *   APPLY      — declares only missing tables, and code uses them. Safe to
 *                dry-run then apply.
 *   VERIFY     — declares only missing tables, but NO code references them.
 *                Probably dead; confirm before spending effort.
 *   INSPECT    — also declares an already-existing table. Cannot be applied
 *                as-is; the existing schema may have diverged. Needs a human.
 *   DELETE-CRT — no code reference AND the migration is superseded. Remove the
 *                CREATE so the baseline shrinks honestly.
 *
 * Nothing here mutates anything. Usage:
 *   node scripts/ci/triage-missing-tables.cjs --live <file>   # markdown
 *   node scripts/ci/triage-missing-tables.cjs --live <file> --json
 */

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { parseMigrationSql } = require('./check-migration-drift.cjs');
const inventory = require('./aurora-migration-inventory.cjs');

const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const BASELINE = join(__dirname, 'migration-drift-baseline.json');

function loadMissing() {
  const raw = JSON.parse(readFileSync(BASELINE, 'utf8'));
  return new Set(raw.known_missing_tables || []);
}

/** table -> the migration file that last declared it, plus every declarer. */
function mapDeclarations() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const declaredBy = new Map(); // table -> [files]
  const fileDeclares = new Map(); // file -> Set(tables)
  for (const file of files) {
    const { created } = parseMigrationSql(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    if (created.size === 0) continue;
    fileDeclares.set(file, created);
    for (const t of created) {
      if (!declaredBy.has(t)) declaredBy.set(t, []);
      declaredBy.get(t).push(file);
    }
  }
  return { declaredBy, fileDeclares };
}

/** How many places in the gateway/frontend actually query each table. */
function codeUsage() {
  const scan = inventory.scan();
  const usage = new Map();
  for (const acc of Object.values(scan)) {
    for (const [table, info] of Object.entries(acc.from || {})) {
      const k = table.toLowerCase();
      const prev = usage.get(k) ?? { calls: 0, files: 0 };
      usage.set(k, { calls: prev.calls + info.count, files: prev.files + info.files.size });
    }
  }
  return usage;
}

function main() {
  const args = process.argv.slice(2);
  const liveIdx = args.indexOf('--live');
  if (liveIdx === -1 || !args[liveIdx + 1]) {
    console.error('usage: triage-missing-tables.cjs --live <file-with-one-table-per-line> [--json]');
    process.exit(2);
  }
  const live = new Set(
    readFileSync(args[liveIdx + 1], 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const missing = loadMissing();
  const { declaredBy, fileDeclares } = mapDeclarations();
  const usage = codeUsage();

  // Group missing tables by the migration file that declares them.
  const byFile = new Map();
  const orphans = [];
  for (const t of missing) {
    const files = declaredBy.get(t);
    if (!files || files.length === 0) { orphans.push(t); continue; }
    const file = files[files.length - 1];
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(t);
  }

  const rows = [];
  for (const [file, tables] of byFile) {
    const declares = fileDeclares.get(file) ?? new Set();
    // The masking hazard: this file also declares a table that ALREADY exists,
    // so CREATE TABLE IF NOT EXISTS will skip it and any later reference to its
    // columns may fail against the live (possibly diverged) definition.
    const alsoExisting = [...declares].filter((t) => live.has(t));
    const totalCalls = tables.reduce((s, t) => s + (usage.get(t)?.calls ?? 0), 0);
    const usedTables = tables.filter((t) => (usage.get(t)?.calls ?? 0) > 0);

    let disposition;
    if (alsoExisting.length > 0) disposition = 'INSPECT';
    else if (totalCalls > 0) disposition = 'APPLY';
    else disposition = 'VERIFY';

    rows.push({
      file,
      missing_tables: tables.sort(),
      missing_count: tables.length,
      also_declares_existing: alsoExisting.sort(),
      code_call_sites: totalCalls,
      used_tables: usedTables.sort(),
      disposition,
    });
  }

  rows.sort((a, b) =>
    b.code_call_sites - a.code_call_sites || b.missing_count - a.missing_count || a.file.localeCompare(b.file));

  if (args.includes('--json')) {
    console.log(JSON.stringify({ generated_from_baseline: BASELINE, orphans, rows }, null, 2));
    return;
  }

  const counts = rows.reduce((m, r) => ((m[r.disposition] = (m[r.disposition] ?? 0) + 1), m), {});
  const tableCounts = rows.reduce((m, r) => ((m[r.disposition] = (m[r.disposition] ?? 0) + r.missing_count), m), {});

  console.log('# Triage — declared-but-absent tables (VTID-03511)\n');
  console.log(`Baseline entries: **${missing.size}** across **${rows.length}** migration files.\n`);
  console.log('| disposition | migrations | tables | meaning |');
  console.log('|---|---|---|---|');
  console.log(`| \`INSPECT\` | ${counts.INSPECT ?? 0} | ${tableCounts.INSPECT ?? 0} | also declares an ALREADY-EXISTING table — cannot apply as-is, schema may have diverged |`);
  console.log(`| \`APPLY\` | ${counts.APPLY ?? 0} | ${tableCounts.APPLY ?? 0} | declares only missing tables AND code queries them |`);
  console.log(`| \`VERIFY\` | ${counts.VERIFY ?? 0} | ${tableCounts.VERIFY ?? 0} | declares only missing tables, no code reference — probably dead |`);
  if (orphans.length) {
    console.log(`\n**${orphans.length} baseline entries have no declaring migration at all** (parser drift or since-deleted file): ${orphans.join(', ')}\n`);
  }

  for (const d of ['INSPECT', 'APPLY', 'VERIFY']) {
    const group = rows.filter((r) => r.disposition === d);
    if (!group.length) continue;
    console.log(`\n## ${d} (${group.length} migrations)\n`);
    console.log('| migration | missing tables | code call sites | also declares (exists) |');
    console.log('|---|---|---|---|');
    for (const r of group) {
      console.log(
        `| \`${r.file}\` | ${r.missing_count}: ${r.missing_tables.slice(0, 6).join(', ')}${r.missing_count > 6 ? ' …' : ''} ` +
          `| ${r.code_call_sites}${r.used_tables.length ? ` (${r.used_tables.slice(0, 3).join(', ')})` : ''} ` +
          `| ${r.also_declares_existing.slice(0, 4).join(', ') || '—'} |`,
      );
    }
  }
}

if (require.main === module) main();
module.exports = { mapDeclarations, codeUsage };
