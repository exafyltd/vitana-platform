/**
 * rls-policy-scanner-v1
 *
 * Parses supabase/migrations/*.sql to build a picture of:
 *   - Which tables exist (CREATE TABLE ...)
 *   - Which ones have RLS enabled (ALTER TABLE ... ENABLE ROW LEVEL SECURITY)
 *   - Which ones have anon-deny / restrictive write policies
 *
 * Flags any table that looks like a write-target (has non-system columns,
 * isn't a view/enum) but lacks BOTH "ENABLE ROW LEVEL SECURITY" AND a
 * policy that restricts writes for 'anon' / 'public'.
 *
 * Heuristic, not a proof. Produces a higher-severity finding because the
 * cost of a false negative (missing RLS) is incident-class.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readFileSafe } from './_shared.mjs';

export const meta = {
  scanner: 'rls-policy-scanner-v1',
  signal_type: 'rls_gap',
};

// Tables that live in non-public schemas or are platform-managed — skip.
// Also skip SQL keywords that can leak through a fuzzy regex match (if, not,
// exists) — harmless given the CHECK in the pattern, but defense-in-depth.
const SKIP_TABLES = new Set([
  'schema_migrations', 'supabase_migrations',
  'if', 'not', 'exists', 'temp', 'temporary', 'unlogged',
]);

function parseMigrations(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return { tables: new Map(), rlsEnabled: new Set(), policies: new Map() };
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const tables = new Map(); // name -> { firstMigration, hasWrites, lastSeenMigration }
  const rlsEnabled = new Set();
  const policies = new Map(); // table -> Array<{ cmd, role, permissive, using, withCheck, from }>

  for (const f of files) {
    let sql = readFileSafe(path.join(migrationsDir, f));
    if (!sql) continue;
    // Strip SQL comments so CREATE TABLE / ALTER TABLE matches don't break
    // on inline -- comments between columns.
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

    // CREATE TABLE [IF NOT EXISTS] [public.]name (
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      const t = m[1].toLowerCase();
      if (SKIP_TABLES.has(t)) continue;
      if (!tables.has(t)) tables.set(t, { firstMigration: f });
    }

    // ALTER TABLE ... ENABLE ROW LEVEL SECURITY
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
      rlsEnabled.add(m[1].toLowerCase());
    }

    // CREATE POLICY ... ON [public.]tablename ...
    for (const m of sql.matchAll(/CREATE\s+POLICY\s+[a-z_"'0-9]+\s+ON\s+(?:public\.)?([a-z_][a-z0-9_]*)([\s\S]*?)(?:;|$)/gi)) {
      const t = m[1].toLowerCase();
      const body = (m[2] || '').toLowerCase();
      const cmd = /for\s+(all|select|insert|update|delete)/.exec(body)?.[1] || 'all';
      const role = /to\s+([a-z_,\s]+?)(?:\s+using|\s+with\s+check|;|$)/.exec(body)?.[1]?.trim() || '';
      const policy = { cmd, role, body };
      if (!policies.has(t)) policies.set(t, []);
      policies.get(t).push(policy);
    }

    // DROP TABLE — remove from our map so we don't falsely flag a dropped table.
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      tables.delete(m[1].toLowerCase());
    }
  }
  return { tables, rlsEnabled, policies };
}

/**
 * A table is considered "write-protected" if RLS is enabled AND at least one
 * policy restricts writes. A permissive-for-ALL policy to `public`/`anon` is
 * NOT write-protected — it's wide open.
 */
function isWriteProtected(table, rlsEnabled, policies) {
  if (!rlsEnabled.has(table)) return false;
  const ps = policies.get(table) || [];
  if (ps.length === 0) {
    // RLS enabled with zero policies = fully locked (service role still works).
    return true;
  }
  // If any policy is "FOR ALL TO public|anon USING (true)" — that's wide open.
  for (const p of ps) {
    if (p.role && (p.role.includes('public') || p.role.includes('anon')) && /using\s*\(\s*true\s*\)/.test(p.body)) {
      return false;
    }
  }
  return true;
}

export async function run({ repoRoot }) {
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  const { tables, rlsEnabled, policies } = parseMigrations(migrationsDir);

  const signals = [];
  for (const [table, meta] of tables) {
    if (isWriteProtected(table, rlsEnabled, policies)) continue;
    signals.push({
      type: 'rls_gap',
      severity: 'high',
      file_path: `supabase/migrations/${meta.firstMigration}`,
      line_number: 1,
      message: `Table \`${table}\` has no RLS policy restricting anon writes. Add "ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY" + a deny-anon policy.`,
      suggested_action: `Add a migration that enables RLS on ${table} and denies unauthenticated writes. See incident #845 (vitana_index_scores) for the pattern.`,
      scanner: 'rls-policy-scanner-v1',
      raw: { table, first_seen_in: meta.firstMigration },
    });
  }
  return signals;
}
