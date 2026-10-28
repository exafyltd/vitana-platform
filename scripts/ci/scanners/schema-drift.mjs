/**
 * schema-drift-scanner-v1
 *
 * Finds column references in the gateway's TypeScript that don't exist in
 * the latest migration state. The bug pattern behind incident #842: a
 * migration renamed a column, but a `from('x').select('old_name, ...')`
 * call in TS kept using the old name. Runtime error surfaces only in prod.
 *
 * Heuristic:
 *   1. Parse supabase/migrations/*.sql to build column inventory per table
 *      (CREATE TABLE + ALTER TABLE ADD COLUMN + ALTER TABLE DROP COLUMN +
 *      ALTER TABLE RENAME COLUMN).
 *   2. Grep services/gateway/src for `.from('<table>')` chained with
 *      `.select('<columns>')` or `.update({ <columns> })` etc., extract the
 *      columns.
 *   3. Flag any column in the TS that isn't in the table's final column set.
 *
 * Known limits (noted in the finding):
 *   - Only catches literal string columns, not dynamic/computed ones.
 *   - Cross-schema joins + relation embeds (.select('a, rel(x)')) strip the
 *     relation embed before column lookup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo } from './_shared.mjs';

export const meta = {
  scanner: 'schema-drift-scanner-v1',
  signal_type: 'schema_drift',
};

function buildColumnInventory(migrationsDir) {
  const tables = new Map(); // name -> Set<column>
  if (!fs.existsSync(migrationsDir)) return tables;
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    let sql = readFileSafe(path.join(migrationsDir, f));
    if (!sql) continue;
    // Strip SQL line comments + block comments before any matchAll.
    // Prevents `-- foo\n  next_col ...` from being parsed as a single comma
    // segment whose first non-whitespace char is `-` (which fails the
    // name-at-start regex).
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

    // CREATE TABLE [IF NOT EXISTS] [public.]name ( ... )
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi)) {
      const name = m[1].toLowerCase();
      const body = m[2];
      const cols = new Set();
      // Split on commas at top-level parenthesis depth 0
      let depth = 0, start = 0;
      const parts = [];
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
      }
      parts.push(body.slice(start));
      for (const p of parts) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        // Skip table-level constraints (PRIMARY KEY (...), UNIQUE (...), FOREIGN KEY ..., CHECK ..., EXCLUDE ...)
        if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE|CONSTRAINT)\b/i.test(trimmed)) continue;
        // Column-name-at-start match. Allow either whitespace or end-of-line
        // as a terminator — covers `col TEXT` (with type) and `col` (rare).
        const cm = /^"?([a-z_][a-z0-9_]*)"?(?:\s|$)/i.exec(trimmed);
        if (cm) cols.add(cm[1].toLowerCase());
      }
      const existing = tables.get(name);
      if (existing) {
        for (const c of cols) existing.add(c);
      } else {
        tables.set(name, cols);
      }
    }

    // ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] col
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      const t = m[1].toLowerCase();
      const c = m[2].toLowerCase();
      if (!tables.has(t)) tables.set(t, new Set());
      tables.get(t).add(c);
    }

    // ALTER TABLE ... DROP COLUMN [IF EXISTS] col
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      const t = m[1].toLowerCase();
      const c = m[2].toLowerCase();
      if (tables.has(t)) tables.get(t).delete(c);
    }

    // ALTER TABLE ... RENAME COLUMN old TO new
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+RENAME\s+COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
      const t = m[1].toLowerCase();
      const oldC = m[2].toLowerCase();
      const newC = m[3].toLowerCase();
      if (tables.has(t)) { tables.get(t).delete(oldC); tables.get(t).add(newC); }
    }
  }
  return tables;
}

// Parse `select(...)` strings into individual column identifiers.
// Strips relation embeds like `related_table(col1, col2)` since those aren't
// column references on the parent table.
function parseSelectList(s) {
  // Remove relation embeds: name(...)
  const stripped = s.replace(/[a-z_][a-z0-9_]*\s*\([^)]*\)/gi, '');
  const cols = stripped.split(',').map(c => c.trim()).filter(Boolean);
  const out = [];
  for (const c of cols) {
    if (c === '*') continue;
    // Aliases: "display_name:name" → we want the DB col (name)
    const parts = c.split(':').map(p => p.trim());
    const actual = parts[parts.length - 1];
    // Skip annotations like "count", "!inner", "!left" etc.
    if (!/^[a-z_][a-z0-9_]*$/i.test(actual)) continue;
    out.push(actual.toLowerCase());
  }
  return out;
}

export async function run({ repoRoot }) {
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  const inventory = buildColumnInventory(migrationsDir);

  const gatewaySrc = path.join(repoRoot, 'services', 'gateway', 'src');
  if (!fs.existsSync(gatewaySrc)) return [];
  const files = walk(gatewaySrc).filter(f => /\.(ts|tsx)$/.test(f));

  const signals = [];
  for (const file of files) {
    const src = readFileSafe(file);
    if (!src) continue;
    // Match .from('table').select('cols') possibly across whitespace/newlines.
    // Only check contiguous .select() that directly references the from()'d table.
    const re = /\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)([\s\S]{0,400}?)\.select\(\s*[`'"]([^`'"]+)[`'"]/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const table = m[1].toLowerCase();
      const selectStr = m[3];
      const inv = inventory.get(table);
      if (!inv || inv.size === 0) continue; // unknown table — skip (could be RPC, view, etc.)
      const cols = parseSelectList(selectStr);
      const missing = cols.filter(c => !inv.has(c));
      if (missing.length === 0) continue;
      const lineNumber = src.slice(0, m.index).split('\n').length;
      signals.push({
        type: 'schema_drift',
        severity: 'high',
        file_path: relFromRepo(repoRoot, file),
        line_number: lineNumber,
        message: `${relFromRepo(repoRoot, file)}:${lineNumber} reads column(s) [${missing.join(', ')}] from \`${table}\` that do not exist in supabase/migrations.`,
        suggested_action: `Either update the SELECT to match the current schema OR add a migration that introduces the missing columns. Cross-check against the latest migration that touched \`${table}\`.`,
        scanner: 'schema-drift-scanner-v1',
        raw: { table, missing_columns: missing },
      });
    }
  }
  return signals;
}
