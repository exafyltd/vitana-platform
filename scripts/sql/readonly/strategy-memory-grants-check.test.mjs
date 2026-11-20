// VTID-05693 (strategy-execution-wave1/security-evidence): guard for the read-only grants check.
//
// strategy-memory-grants-check.sql is run by an authorised operator against a live database. This test proves, without
// a database, that the file can only read: every statement starts with SELECT or WITH, no write or session keyword
// starts a statement or a sub-statement, and nothing turns a SELECT into a write (SELECT ... INTO, FOR UPDATE, side-effect
// functions). It also fails when the file stops covering the four memory functions, the four roles or the nine tables.
// No dependencies: node:test and node:assert only. Run: node --test scripts/sql/readonly/strategy-memory-grants-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SQL_PATH = fileURLToPath(new URL('./strategy-memory-grants-check.sql', import.meta.url));

const ALLOWED_STARTS = ['SELECT', 'WITH'];
const FORBIDDEN_STARTS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'TRUNCATE', 'COPY', 'CALL',
  'DO', 'SET', 'RESET', 'BEGIN', 'COMMIT', 'VACUUM', 'ANALYZE', 'LOCK', 'COMMENT', 'SECURITY', 'EXECUTE',
  // Same class, also refused: other transaction, session and maintenance statements.
  'START', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT', 'PREPARE', 'DEALLOCATE', 'DISCARD', 'REFRESH',
  'REINDEX', 'CLUSTER', 'LISTEN', 'NOTIFY', 'UNLISTEN', 'LOAD', 'IMPORT', 'REASSIGN', 'CHECKPOINT',
];
// Functions with side effects that a SELECT could call.
const FORBIDDEN_FUNCTIONS = [
  'set_config', 'nextval', 'setval', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'pg_advisory_lock', 'pg_advisory_xact_lock', 'pg_try_advisory_lock', 'lo_import', 'lo_export', 'dblink',
  'dblink_exec', 'pg_notify', 'pg_rotate_logfile', 'pg_switch_wal', 'pg_create_restore_point',
];
const REQUIRED_FUNCTIONS = ['write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search'];
const REQUIRED_ROLES = ['anon', 'authenticated', 'service_role', 'migrate'];
const REQUIRED_TABLES = [
  'memory_items', 'memory_facts', 'memory_diary_entries', 'relationship_edges', 'vtid_ledger', 'oasis_events',
  'user_tenants', 'tenants', 'app_users',
];
const REQUIRED_CATALOG_TERMS = [
  'has_function_privilege', 'prosecdef', 'proacl', 'to_regrole', 'to_regclass', 'relrowsecurity',
  'relforcerowsecurity', 'pg_policies',
];

/** Remove -- line comments and nested block comments. String literals and quoted identifiers are kept intact. */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === q && sql[j + 1] === q) { j += 2; continue; }
        if (sql[j] === q) break;
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && d === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
    } else if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Replace the content of string literals with blanks so keywords inside strings are not read as SQL. */
export function blankStrings(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Find every reason the SQL text is not read-only. Empty array = read-only. */
export function readOnlyViolations(rawSql) {
  const errors = [];
  const noComments = stripComments(rawSql);
  if (/\$[A-Za-z_]*\$/.test(noComments)) errors.push('dollar-quoted body found (DO / function bodies are not allowed)');
  if (/\\[A-Za-z!]/.test(noComments)) errors.push('psql meta-command found');
  const code = blankStrings(noComments);
  const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
  if (statements.length === 0) errors.push('no statement found');
  for (const [idx, stmt] of statements.entries()) {
    const first = (stmt.match(/^[(\s]*([A-Za-z_]+)/) || [])[1];
    const kw = first ? first.toUpperCase() : '';
    if (!ALLOWED_STARTS.includes(kw)) errors.push(`statement ${idx + 1} starts with "${kw || stmt.slice(0, 20)}", not SELECT/WITH`);
    // A data-modifying CTE or a nested statement starts right after "(" or after "AS (".
    for (const m of stmt.matchAll(/\(\s*([A-Za-z_]+)/g)) {
      const inner = m[1].toUpperCase();
      if (FORBIDDEN_STARTS.includes(inner)) errors.push(`statement ${idx + 1} has "${inner}" as a sub-statement start`);
    }
    if (/\bINTO\b/i.test(stmt)) errors.push(`statement ${idx + 1} uses INTO (SELECT INTO creates a table)`);
    if (/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i.test(stmt)) errors.push(`statement ${idx + 1} takes row locks`);
    for (const fn of FORBIDDEN_FUNCTIONS) {
      if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(stmt)) errors.push(`statement ${idx + 1} calls ${fn}()`);
    }
  }
  return errors;
}

/** Names the file must mention outside comments (string literals count: role names are passed as text). */
export function missingNames(rawSql) {
  const text = stripComments(rawSql);
  const want = [...REQUIRED_FUNCTIONS, ...REQUIRED_ROLES, ...REQUIRED_TABLES, ...REQUIRED_CATALOG_TERMS];
  return want.filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
}

// ── The checker itself (fixtures), so a broken checker cannot pass the real file ─────────────────────────────────
test('checker accepts plain SELECT and WITH statements', () => {
  assert.deepEqual(readOnlyViolations("SELECT 1; WITH x AS (SELECT 2) SELECT * FROM x;"), []);
  assert.deepEqual(readOnlyViolations("SELECT has_function_privilege('anon', 1::oid, 'EXECUTE');"), []);
  assert.deepEqual(readOnlyViolations("-- DROP TABLE x;\nSELECT 1; /* DELETE FROM y; */"), []);
});

test('checker refuses every forbidden statement start', () => {
  for (const kw of FORBIDDEN_STARTS) {
    const v = readOnlyViolations(`SELECT 1;\n${kw} something;`);
    assert.ok(v.length > 0, `${kw} must be refused`);
  }
});

test('checker refuses data-modifying CTEs, SELECT INTO, row locks, side-effect functions, DO bodies', () => {
  assert.ok(readOnlyViolations('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d;').length > 0);
  assert.ok(readOnlyViolations('WITH u AS ( UPDATE t SET a = 1 RETURNING *) SELECT 1;').length > 0);
  assert.ok(readOnlyViolations('SELECT * INTO new_t FROM t;').length > 0);
  assert.ok(readOnlyViolations('SELECT * FROM t FOR UPDATE;').length > 0);
  assert.ok(readOnlyViolations("SELECT set_config('role', 'x', false);").length > 0);
  assert.ok(readOnlyViolations('DO $x$ BEGIN END $x$;').length > 0);
  assert.ok(readOnlyViolations('SELECT 1;\n\\gexec').length > 0);
  assert.ok(readOnlyViolations('').length > 0);
});

test('checker reports a missing function, role or table', () => {
  const full = [...REQUIRED_FUNCTIONS, ...REQUIRED_ROLES, ...REQUIRED_TABLES, ...REQUIRED_CATALOG_TERMS]
    .map((n) => `'${n}'`).join(', ');
  assert.deepEqual(missingNames(`SELECT ${full};`), []);
  assert.deepEqual(missingNames(`SELECT ${full.replace("'migrate'", "'x'")};`), ['migrate']);
  assert.deepEqual(missingNames(`-- write_fact\nSELECT ${full.replace("'write_fact'", "'y'")};`), ['write_fact']);
});

// ── The real file ─────────────────────────────────────────────────────────────────────────────────────────────────
test('strategy-memory-grants-check.sql exists and is read-only (SELECT/WITH only)', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  assert.deepEqual(readOnlyViolations(sql), []);
});

test('strategy-memory-grants-check.sql covers the four functions, four roles, nine tables and catalog checks', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  assert.deepEqual(missingNames(sql), []);
});
