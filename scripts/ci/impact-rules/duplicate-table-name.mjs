/**
 * duplicate-table-name
 *
 * A migration added in this PR doing CREATE TABLE foo fails at psql time
 * if foo already exists from a prior migration. psql errors are reported
 * by RUN-MIGRATION.yml AFTER merge — catching it at PR time is cheaper.
 *
 * Logic:
 *   - For each added migration in the PR, extract CREATE TABLE names.
 *   - For each name, grep the baseline (all OTHER migrations, plus the
 *     SAME migration at pre-PR state) for a prior CREATE TABLE of that name
 *     without a paired DROP TABLE later.
 *
 * The migration-ordering guard (separate rule, future) will cover the
 * subtler case of CREATE TABLE IF NOT EXISTS with a diverging column list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'duplicate-table-name',
  category: 'conflict',
  severity: 'blocker',
};

function extractCreateTables(sql) {
  const out = [];
  if (!sql) return out;
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    out.push({ name: m[1].toLowerCase(), hasIfNotExists: /IF\s+NOT\s+EXISTS/i.test(m[0]) });
  }
  return out;
}

function extractDropTables(sql) {
  const out = new Set();
  if (!sql) return out;
  const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) out.add(m[1].toLowerCase());
  return out;
}

export async function check({ changedFiles, repoRoot }) {
  const addedMigrations = changedFiles.filter(f =>
    f.status === 'A' && /^supabase\/migrations\/.+\.sql$/.test(f.path)
  );
  if (addedMigrations.length === 0) return [];

  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  if (!fs.existsSync(migrationsDir)) return [];

  // Build a set of existing live tables (name -> oldestMigrationFile).
  // We include ALL migrations currently on disk, which in the CI worktree
  // includes the PR's own adds — we need to exclude those so we compare
  // against the pre-PR state.
  const addedSet = new Set(addedMigrations.map(f => path.basename(f.path)));
  const existingCreates = new Map();   // name -> first migration
  const existingDrops = new Map();     // name -> count of drops

  const allFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of allFiles) {
    if (addedSet.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const c of extractCreateTables(sql)) {
      if (!existingCreates.has(c.name)) existingCreates.set(c.name, f);
    }
    const drops = extractDropTables(sql);
    for (const d of drops) existingDrops.set(d, (existingDrops.get(d) || 0) + 1);
  }

  // Prune tables that were dropped and never re-created after the drop.
  for (const [name] of existingCreates) {
    if (existingDrops.has(name)) existingCreates.delete(name);
  }

  const findings = [];
  for (const m of addedMigrations) {
    const sql = readFileAtRepo(repoRoot, m.path);
    if (!sql) continue;
    const creates = extractCreateTables(sql);
    for (const c of creates) {
      if (c.hasIfNotExists) continue; // idempotent — psql won't error
      if (existingCreates.has(c.name)) {
        findings.push({
          rule: meta.rule,
          severity: meta.severity,
          file_path: m.path,
          line_number: null,
          message: `${m.path} creates table \`${c.name}\`, but \`${c.name}\` was already created by ${existingCreates.get(c.name)}. psql will error at migration time.`,
          suggested_action: `Either (a) use CREATE TABLE IF NOT EXISTS if the intent is idempotent, (b) use ALTER TABLE to modify the existing table, or (c) rename the new table to avoid the collision.`,
          raw: { table_name: c.name, existing_migration: existingCreates.get(c.name) },
        });
      }
    }
  }
  return findings;
}
