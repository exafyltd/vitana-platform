#!/usr/bin/env node
/**
 * VTID-05465 (mt-identity-r2 / helpers-and-policy-rewrite) — N3 bare-policy lint.
 *
 * A "bare" policy filters on `current_tenant_id()` and nothing that ties the row to the
 * caller: no auth.uid(), current_user_id(), is_member(), is_tenant_admin(), auth.role()
 * or service_role check. Such a policy admits every caller whose resolved tenant matches,
 * so it opens a table tenant-wide the moment `current_tenant_id()` resolves for a session.
 * The N3 ordering gate (docs/MULTI-TENANT-PLAN.md, plan mt-identity-r2) requires this
 * lint to read ZERO before any later migration redefines `current_tenant_id()`.
 *
 * How it counts (the same parser the plan's recount used):
 *   - every `supabase/migrations/*.sql` file in filename order (sub-folders such as
 *     `data-fixups/` are not migrations);
 *   - files ending in `_rollback.sql` that pair with a forward migration of the same
 *     stem are rollbacks, not forward state, and are skipped;
 *   - CREATE POLICY defines a policy (last definition wins per table + policy name),
 *     DROP POLICY removes it, DROP TABLE removes every policy on the table,
 *     ALTER TABLE … RENAME TO moves policies to the new name;
 *   - statements inside DO / function bodies ($$ … $$) are parsed too; text inside
 *     string literals (EXECUTE '…', format('…')) is not — such dynamic policies cannot be
 *     resolved statically and none of today's references a bare tenant filter.
 *
 * Allowlist: ALLOWLIST below holds owner-tagged tenant-shared exceptions. Every entry
 * needs `table`, `policy` and `owner_decision` (where the owner approved it). It is
 * empty: no bare policy is approved.
 *
 * Usage:
 *   node scripts/ci/bare-policy-lint.mjs            # text report, exit 1 when count > 0
 *   node scripts/ci/bare-policy-lint.mjs --json     # JSON report (same exit code)
 *   node scripts/ci/bare-policy-lint.mjs --dir <migrations dir> [--include-rollbacks]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(HERE, '..', '..', 'supabase', 'migrations');

/** Owner-tagged tenant-shared exceptions: [{ table, policy, owner_decision }]. */
export const ALLOWLIST = Object.freeze([]);

const GUARD = /\bauth\s*\.\s*uid\s*\(|\bcurrent_user_id\s*\(|\bis_member\s*\(|\bis_tenant_admin\s*\(|\bauth\s*\.\s*role\s*\(|\bservice_role\b/i;
const TENANT_FILTER = /\bcurrent_tenant_id\s*\(/i;
const PRIVILEGED_ROLES = new Set(['service_role', 'postgres', 'supabase_admin']);

/**
 * Split SQL into top-level statements. Returns [{ text, mask, start }] where `mask` is
 * `text` with comments, string literals and dollar-quoted bodies blanked out (same
 * length), and `bodies` are the dollar-quoted bodies (parsed recursively by the caller).
 */
export function splitStatements(sql, base = 0) {
  const out = [];
  const bodies = [];
  let mask = '';
  let stmtStart = 0;
  let i = 0;
  const n = sql.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const e = sql.indexOf('\n', i);
      const end = e === -1 ? n : e;
      mask += blank(sql.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      mask += blank(sql.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j += 1;
      }
      const end = Math.min(n, j + 1);
      mask += "'" + blank(sql.slice(i + 1, end - 1)) + (end - 1 > i ? "'" : '');
      i = end;
      continue;
    }
    if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      const end = e === -1 ? n : e + 1;
      mask += sql.slice(i, end); // quoted identifiers stay visible
      i = end;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        const bodyStart = i + tag.length;
        const bodyEnd = e === -1 ? n : e;
        bodies.push({ text: sql.slice(bodyStart, bodyEnd), start: base + bodyStart });
        const end = e === -1 ? n : e + tag.length;
        mask += tag + blank(sql.slice(bodyStart, bodyEnd)) + (e === -1 ? '' : tag);
        i = end;
        continue;
      }
    }
    if (c === ';') {
      mask += ';';
      out.push({ text: sql.slice(stmtStart, i + 1), mask: mask.slice(stmtStart, i + 1), start: base + stmtStart });
      stmtStart = i + 1;
      i += 1;
      continue;
    }
    mask += c;
    i += 1;
  }
  if (stmtStart < n && sql.slice(stmtStart).trim()) {
    out.push({ text: sql.slice(stmtStart), mask: mask.slice(stmtStart), start: base + stmtStart });
  }
  return { statements: out, bodies };
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

function unquote(id) {
  const t = id.trim();
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
}
function tableName(q) {
  const parts = q.split(/\s*\.\s*(?=(?:"|[A-Za-z_]))/).map(unquote);
  return parts[parts.length - 1];
}

const RE_CREATE = new RegExp(String.raw`\bCREATE\s+POLICY\s+(${IDENT})\s+ON\s+(?:ONLY\s+)?(${QNAME})`, 'gi');
const RE_DROP_POLICY = new RegExp(String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?(${QNAME})`, 'gi');
const RE_DROP_TABLE = new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:${QNAME})(?:\s*,\s*${QNAME})*)`, 'gi');
const RE_RENAME_TABLE = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\s+RENAME\s+TO\s+(${IDENT})`, 'gi');
const RE_ALTER_POLICY_RENAME = new RegExp(String.raw`\bALTER\s+POLICY\s+(${IDENT})\s+ON\s+(${QNAME})\s+RENAME\s+TO\s+(${IDENT})`, 'gi');

function lineOf(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** Collect policy events from one SQL text, in source order. */
export function policyEvents(sql) {
  const lineStarts = [0];
  for (let k = 0; k < sql.length; k += 1) if (sql[k] === '\n') lineStarts.push(k + 1);
  const events = [];
  const walk = (text, base) => {
    const { statements, bodies } = splitStatements(text, base);
    const local = [];
    for (const st of statements) {
      const scan = (re, kind) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(st.mask)) !== null) local.push({ kind, m, st, at: st.start + m.index });
      };
      scan(RE_CREATE, 'create');
      scan(RE_DROP_POLICY, 'drop_policy');
      scan(RE_DROP_TABLE, 'drop_table');
      scan(RE_RENAME_TABLE, 'rename_table');
      scan(RE_ALTER_POLICY_RENAME, 'rename_policy');
    }
    for (const b of bodies) walk(b.text, b.start);
    events.push(...local);
  };
  walk(sql, 0);
  events.sort((a, b) => a.at - b.at);
  return events.map(({ kind, m, st, at }) => {
    const line = lineOf(lineStarts, at);
    if (kind === 'create') {
      const rel = m.index;
      const def = st.text.slice(rel).replace(/;\s*$/, '');
      const defMask = st.mask.slice(rel);
      return { kind, policy: unquote(m[1]), table: tableName(m[2]), line, definition: def, definitionMask: defMask };
    }
    if (kind === 'drop_policy') return { kind, policy: unquote(m[1]), table: tableName(m[2]), line };
    if (kind === 'drop_table') return { kind, tables: m[1].split(',').map((s) => tableName(s.trim())), line };
    if (kind === 'rename_table') return { kind, table: tableName(m[1]), to: unquote(m[2]), line };
    return { kind, policy: unquote(m[1]), table: tableName(m[2]), to: unquote(m[3]), line };
  });
}

function stripComments(s) {
  return s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Parse the clauses of a CREATE POLICY definition. */
export function classifyDefinition(definition) {
  const def = stripComments(definition);
  const cmd = (/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(def) || [null, 'ALL'])[1].toUpperCase();
  const toM = /\bTO\s+([A-Za-z_"][\w",\s]*?)(?=\s+(?:USING|WITH\s+CHECK)\b|\s*$)/i.exec(def);
  const roles = toM ? toM[1].split(',').map((r) => unquote(r)).filter(Boolean) : ['public'];
  const privilegedOnly = roles.length > 0 && roles.every((r) => PRIVILEGED_ROLES.has(r));
  const tenantFilter = TENANT_FILTER.test(def);
  const guarded = GUARD.test(def);
  return { cmd, roles, tenantFilter, guarded, bare: tenantFilter && !guarded && !privilegedOnly };
}

/** Migration files in apply order. Rollbacks of a forward migration are skipped unless asked. */
export function migrationFiles(dir, { includeRollbacks = false } = {}) {
  const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const names = new Set(all);
  return all.filter((f) => {
    if (includeRollbacks) return true;
    const m = /^(.*)_rollback\.sql$/.exec(f);
    return !(m && names.has(`${m[1]}.sql`));
  });
}

/** Final policy state across the files (last definition wins). */
export function finalPolicies(dir, opts = {}) {
  const state = new Map(); // `${table}::${policy}` -> record
  for (const file of migrationFiles(dir, opts)) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const ev of policyEvents(sql)) {
      if (ev.kind === 'create') {
        state.set(`${ev.table}::${ev.policy}`, { table: ev.table, policy: ev.policy, file, line: ev.line, definition: ev.definition });
      } else if (ev.kind === 'drop_policy') {
        state.delete(`${ev.table}::${ev.policy}`);
      } else if (ev.kind === 'drop_table') {
        for (const key of [...state.keys()]) if (ev.tables.includes(key.split('::')[0])) state.delete(key);
      } else if (ev.kind === 'rename_table') {
        for (const [key, rec] of [...state.entries()]) {
          if (rec.table === ev.table) { state.delete(key); state.set(`${ev.to}::${rec.policy}`, { ...rec, table: ev.to }); }
        }
      } else if (ev.kind === 'rename_policy') {
        const rec = state.get(`${ev.table}::${ev.policy}`);
        if (rec) { state.delete(`${ev.table}::${ev.policy}`); state.set(`${ev.table}::${ev.to}`, { ...rec, policy: ev.to }); }
      }
    }
  }
  return [...state.values()];
}

export function lint(dir = DEFAULT_DIR, opts = {}) {
  const allow = new Set(ALLOWLIST.map((a) => `${a.table}::${a.policy}`));
  const policies = finalPolicies(dir, opts);
  const bare = [];
  const allowlisted = [];
  for (const p of policies) {
    const c = classifyDefinition(p.definition);
    if (!c.bare) continue;
    const rec = { table: p.table, policy: p.policy, cmd: c.cmd, roles: c.roles, file: p.file, line: p.line };
    (allow.has(`${p.table}::${p.policy}`) ? allowlisted : bare).push(rec);
  }
  const sort = (a, b) => a.table.localeCompare(b.table) || a.policy.localeCompare(b.policy);
  bare.sort(sort);
  allowlisted.sort(sort);
  return {
    dir,
    files: migrationFiles(dir, opts).length,
    policies: policies.length,
    count: bare.length,
    tables: [...new Set(bare.map((b) => b.table))].length,
    bare,
    allowlisted,
  };
}

function main(argv) {
  const json = argv.includes('--json');
  const di = argv.indexOf('--dir');
  const dir = di >= 0 ? resolve(argv[di + 1]) : DEFAULT_DIR;
  if (!existsSync(dir)) {
    process.stderr.write(`bare-policy-lint: no such directory ${dir}\n`);
    return 2;
  }
  const report = lint(dir, { includeRollbacks: argv.includes('--include-rollbacks') });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`bare-policy-lint: ${report.count} bare current_tenant_id() policies on ${report.tables} tables `
      + `(${report.policies} policies in ${report.files} files; allowlisted ${report.allowlisted.length})\n`);
    for (const b of report.bare) process.stdout.write(`  ${b.table}.${b.policy} [${b.cmd}] ${b.file}:${b.line}\n`);
  }
  return report.count === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
