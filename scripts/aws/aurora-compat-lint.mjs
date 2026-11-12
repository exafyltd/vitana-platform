#!/usr/bin/env node
// VTID-05023 Phase B1: Aurora-compatibility lint for supabase/migrations/*.sql.
//
// Flags SQL that Aurora PostgreSQL cannot run because it depends on Supabase-only objects:
//   - the auth schema (auth.uid(), auth.users, auth.role(), auth.jwt() ...)
//   - the storage schema (storage.objects, storage.buckets ...)
//   - Supabase-only roles (anon, authenticated, service_role) in TO / ROLE / GRANT clauses
//   - Supabase-only extensions (pg_graphql, pgsodium, supabase_vault, pg_net)
//
// Usage:
//   node scripts/aws/aurora-compat-lint.mjs <file.sql>...        lint the named files
//   node scripts/aws/aurora-compat-lint.mjs --all                lint every supabase/migrations/*.sql
//   node scripts/aws/aurora-compat-lint.mjs --base <ref> --head <ref>   lint migrations changed in a PR
// Exit code: 0 clean, 1 flagged, 2 usage error.
// Comments are stripped before matching, so a rule does not fire on "-- auth.uid() in old text".
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';

export const RULES = [
  { id: 'auth-schema', re: /\bauth\.[a-z_]+/gi, why: 'auth schema is Supabase-only; use auth_user_fk_map or the auth bridge' },
  { id: 'storage-schema', re: /\bstorage\.[a-z_]+/gi, why: 'storage schema is Supabase-only; Storage stays on Supabase in option B' },
  { id: 'supabase-role', re: /\b(?:TO|ROLE|GRANT\s+[^;]*?\bTO)\s+(?:anon|authenticated|service_role)\b/gi, why: 'Supabase-only role' },
  { id: 'supabase-extension', re: /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(pg_graphql|pgsodium|supabase_vault|pg_net)"?/gi, why: 'extension Aurora does not provide' },
];

// Remove -- line comments and /* */ block comments, keeping line numbers.
export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (sql[i] === "'") {
      // Keep string literals, but blank them so text like 'auth.uid' inside a string is not flagged.
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      const stop = Math.min(j + 1, sql.length);
      out += sql.slice(i, stop).replace(/[^\n']/g, ' ');
      i = stop;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

export function lintSql(sql) {
  const clean = stripComments(sql);
  const findings = [];
  for (const rule of RULES) {
    for (const m of clean.matchAll(rule.re)) {
      const line = clean.slice(0, m.index).split('\n').length;
      findings.push({ rule: rule.id, line, text: m[0].trim().slice(0, 80), why: rule.why });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function lintFiles(files) {
  const results = [];
  for (const f of files) {
    const findings = lintSql(readFileSync(f, 'utf8'));
    results.push({ file: f, findings });
  }
  return results;
}

function changedMigrations(base, head) {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head}`, '--', 'supabase/migrations/*.sql'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter(f => existsSync(f));
}

function main(argv) {
  const args = argv.slice(2);
  let files;
  if (args.includes('--all')) {
    const dir = 'supabase/migrations';
    files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => join(dir, f));
  } else if (args.includes('--base')) {
    const base = args[args.indexOf('--base') + 1];
    const head = args[args.indexOf('--head') + 1];
    if (!base || !head) { console.error('usage: --base <ref> --head <ref>'); return 2; }
    files = changedMigrations(base, head);
  } else if (args.length) {
    files = args.map(f => resolve(f));
  } else {
    console.error('usage: aurora-compat-lint.mjs (--all | --base <ref> --head <ref> | <file.sql>...)');
    return 2;
  }
  const results = lintFiles(files);
  const flagged = results.filter(r => r.findings.length);
  for (const r of flagged) {
    for (const f of r.findings) console.log(`${basename(r.file)}:${f.line} [${f.rule}] ${f.text}`);
  }
  console.log(`checked ${results.length} file(s); flagged ${flagged.length}; clean ${results.length - flagged.length}`);
  return flagged.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv);
}
