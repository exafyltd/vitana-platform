/**
 * Operator Console read-only SQL — VTID-04023 (operator agent W5b).
 *
 * Backs `dev_run_sql_readonly`: one bounded SELECT/WITH/EXPLAIN statement
 * over a DEDICATED read-only Postgres connection, for the developer/admin
 * operator. Until now the console's only DB read was `dev_db_query`
 * (VTID-03837): four allowlisted tables through PostgREST, newest rows
 * first, an optional vtid filter — no joins, no aggregates, no other table.
 * A Claude Code session answers "how many executions failed this week and
 * on which stage" with one query; the console could not.
 *
 * Defence in depth, every layer independent of the others:
 *   1. Kill switch: OPERATOR_SQL_READONLY_ENABLED must be the exact string
 *      'true' (same convention as OPERATOR_AWS_READONLY_ENABLED).
 *   2. Connection: OPERATOR_SQL_READONLY_DATABASE_URL — its OWN env var,
 *      never a silent reuse of AURORA_DATABASE_URL (the `vitana_admin`
 *      superuser secret, VTID-03773) or AURORA_RLS_DATABASE_URL (the RLS
 *      diagnostic's `authenticator` role, VTID-03591). The owner points it
 *      at a read-only login role on the Aurora READER endpoint; unset means
 *      the tool honestly reports `not_configured`, exactly like Bedrock
 *      without BEDROCK_ROLE_ARN (CLAUDE.md IF-THEN 31).
 *   3. Statement shape: comments stripped, a single statement, must start
 *      with SELECT / WITH / EXPLAIN (never EXPLAIN ANALYZE), no locking
 *      clauses, no server-side function that sleeps, reads files, signals
 *      backends or changes settings; bounded length.
 *   4. Transaction: BEGIN READ ONLY + SET LOCAL statement_timeout /
 *      lock_timeout / idle_in_transaction_session_timeout, always ROLLBACK —
 *      even a statement that slipped past (3) cannot write or hold a lock.
 *   5. Output: the SELECT is wrapped in `SELECT * FROM (…) LIMIT n`, cells
 *      are clipped, the whole payload is capped.
 *
 * Every execution is logged (thread, statement hash, rows, ms) so the
 * CloudWatch log (readable via dev_cloudwatch_logs, VTID-04020) is the
 * audit trail. Ships inert: nothing is pinned on any deploy workflow here.
 */

import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { resolveAuroraSsl } from './aurora-client';

export const SQL_MAX_CHARS = 4_000;
export const SQL_DEFAULT_ROWS = 50;
export const SQL_MAX_ROWS = 200;
export const SQL_DEFAULT_TIMEOUT_MS = 5_000;
export const SQL_MAX_TIMEOUT_MS = 15_000;
export const SQL_CELL_MAX_CHARS = 400;
export const SQL_TOTAL_MAX_CHARS = 24_000;

export function isSqlReadonlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPERATOR_SQL_READONLY_ENABLED === 'true';
}

export function getSqlReadonlyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.OPERATOR_SQL_READONLY_DATABASE_URL || '').trim();
  return v || null;
}

// ---------------------------------------------------------------------------
// Statement validation (pure)
// ---------------------------------------------------------------------------

/** Server-side functions/keywords a diagnostic read never needs. Matched on
 *  the comment-stripped, lower-cased statement as whole identifiers. */
const FORBIDDEN_TOKENS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\bpg_sleep(?:_for|_until)?\s*\(/, why: 'pg_sleep' },
  { re: /\bpg_read_(?:binary_)?file\s*\(/, why: 'pg_read_file' },
  { re: /\bpg_ls_dir\s*\(/, why: 'pg_ls_dir' },
  { re: /\bpg_(?:terminate|cancel)_backend\s*\(/, why: 'backend signalling' },
  { re: /\bset_config\s*\(/, why: 'set_config' },
  { re: /\bpg_reload_conf\s*\(/, why: 'pg_reload_conf' },
  { re: /\bdblink\w*\s*\(/, why: 'dblink' },
  { re: /\blo_(?:import|export|unlink|put|from_bytea)\s*\(/, why: 'large-object I/O' },
  { re: /\bpg_notify\s*\(/, why: 'pg_notify' },
  { re: /\bnextval\s*\(/, why: 'nextval (advances a sequence)' },
  { re: /\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b/, why: 'row locking clause' },
  { re: /\binto\s+(?:temp|temporary|unlogged)?\s*(?:table\s+)?[a-z_"]/, why: 'SELECT INTO' },
  { re: /\bcopy\b/, why: 'COPY' },
];

/** Strip line (`--`) and block comments so a keyword cannot hide behind one. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export interface ValidatedSql {
  /** The statement to run, trailing semicolon removed. */
  sql: string;
  kind: 'select' | 'with' | 'explain';
}

/** Throws with a precise reason when the statement is not a bounded read. */
export function validateReadonlySql(input: string): ValidatedSql {
  const raw = (input || '').trim();
  if (!raw) throw new Error('sql is required');
  if (raw.length > SQL_MAX_CHARS) throw new Error(`sql is ${raw.length} chars — max ${SQL_MAX_CHARS}`);
  let sql = stripSqlComments(raw).trim();
  // One statement: a single trailing semicolon is tolerated, any other is not.
  sql = sql.replace(/;\s*$/, '').trim();
  if (sql.includes(';')) throw new Error('exactly one statement is allowed (a second ";" was found)');
  if (!sql) throw new Error('sql is required');
  const lower = sql.toLowerCase();
  let kind: ValidatedSql['kind'];
  if (/^select\b/.test(lower)) kind = 'select';
  else if (/^with\b/.test(lower)) kind = 'with';
  else if (/^explain\b/.test(lower)) {
    if (/^explain\s*(?:\(.*\banalyze\b|analyze\b)/s.test(lower)) throw new Error('EXPLAIN ANALYZE executes the statement — use plain EXPLAIN');
    kind = 'explain';
  } else {
    throw new Error('only a single SELECT, WITH … SELECT or EXPLAIN statement is allowed (no INSERT/UPDATE/DELETE/DDL/CALL/SET)');
  }
  if (kind === 'with' && !/\bselect\b/.test(lower)) throw new Error('a WITH statement must end in a SELECT');
  if (kind === 'with' && /\b(?:insert|update|delete|merge)\b/.test(lower)) throw new Error('data-modifying CTEs are not allowed');
  for (const t of FORBIDDEN_TOKENS) {
    if (t.re.test(lower)) throw new Error(`not allowed in a read-only diagnostic query: ${t.why}`);
  }
  return { sql, kind };
}

export function clampRows(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), SQL_MAX_ROWS) : SQL_DEFAULT_ROWS;
}

export function clampTimeoutMs(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), SQL_MAX_TIMEOUT_MS) : SQL_DEFAULT_TIMEOUT_MS;
}

/** Wrap a SELECT/WITH in a bounded outer query; EXPLAIN output is a few rows already. */
export function boundStatement(v: ValidatedSql, maxRows: number): string {
  if (v.kind === 'explain') return v.sql;
  return `SELECT * FROM (\n${v.sql}\n) AS _operator_ro LIMIT ${maxRows + 1}`;
}

export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Output bounding (pure)
// ---------------------------------------------------------------------------

function renderCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') return v;
  else if (Buffer.isBuffer(v)) s = `<${v.length} bytes>`;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  return s.length > SQL_CELL_MAX_CHARS ? `${s.slice(0, SQL_CELL_MAX_CHARS)}…` : s;
}

export interface BoundedRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
  note?: string;
}

/** Clip cells, stop at maxRows and at the total character budget. */
export function boundRows(rawRows: Array<Record<string, unknown>>, maxRows: number, totalMax = SQL_TOTAL_MAX_CHARS): BoundedRows {
  const columns = rawRows.length ? Object.keys(rawRows[0]) : [];
  const rows: Array<Record<string, unknown>> = [];
  let total = 0;
  let truncated = rawRows.length > maxRows;
  for (const r of rawRows.slice(0, maxRows)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) out[k] = renderCell(r[k]);
    const size = JSON.stringify(out).length;
    if (total + size > totalMax) { truncated = true; break; }
    total += size;
    rows.push(out);
  }
  return {
    columns,
    rows,
    row_count: rows.length,
    truncated,
    ...(rows.length === 0 ? { note: 'no rows returned' } : {}),
    ...(truncated ? { note: `truncated at ${rows.length} rows / ${SQL_TOTAL_MAX_CHARS} chars — add a WHERE, an ORDER BY … LIMIT, or aggregate` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let pool: Pool | null = null;
let poolUrl: string | null = null;

/** Minimal client surface so tests can inject a fake. */
export interface RoClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

export interface RoPool { connect(): Promise<RoClient> }

function getReadonlyPool(env: NodeJS.ProcessEnv = process.env): RoPool | null {
  const url = getSqlReadonlyUrl(env);
  if (!url) return null;
  if (pool && poolUrl === url) return pool;
  pool = new Pool({
    connectionString: url,
    ssl: resolveAuroraSsl(),
    max: Number(env.OPERATOR_SQL_READONLY_POOL_MAX || 2),
    idleTimeoutMillis: 30_000,
    // The role is expected to be read-only; this is belt and braces on top.
    options: '-c default_transaction_read_only=on',
  });
  pool.on('error', (err) => console.error('[VTID-04023] idle read-only pool client error:', err));
  poolUrl = url;
  return pool;
}

/** Tests only. */
export function resetSqlReadonlyPool(): void { pool = null; poolUrl = null; }

export interface RunSqlInput { sql: string; max_rows?: number; timeout_ms?: number }

export interface RunSqlResult extends BoundedRows {
  kind: ValidatedSql['kind'];
  statement_fingerprint: string;
  duration_ms: number;
  read_only_transaction: true;
}

/**
 * Validate, then run inside BEGIN READ ONLY with local timeouts and always
 * ROLLBACK. Throws on validation failure, on `not_configured`, and with the
 * Postgres error verbatim on a query failure.
 */
export async function runReadonlySql(
  input: RunSqlInput,
  opts: { pool?: RoPool | null; env?: NodeJS.ProcessEnv; now?: () => number; threadId?: string } = {},
): Promise<RunSqlResult> {
  const env = opts.env || process.env;
  const v = validateReadonlySql(input.sql);
  const maxRows = clampRows(input.max_rows);
  const timeoutMs = clampTimeoutMs(input.timeout_ms);
  const p = opts.pool === undefined ? getReadonlyPool(env) : opts.pool;
  if (!p) throw new Error('not_configured: OPERATOR_SQL_READONLY_DATABASE_URL is not set — the owner provisions a read-only role on the Aurora reader and wires it into the task definition');
  const now = opts.now || Date.now;
  const fp = sqlFingerprint(v.sql);
  const started = now();
  const client = await p.connect();
  try {
    await client.query('BEGIN READ ONLY');
    // Integer settings — clamped above, never user text.
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = ${Math.min(timeoutMs, 2_000)}`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs + 5_000}`);
    const res = await client.query(boundStatement(v, maxRows));
    const bounded = boundRows(res.rows || [], maxRows);
    const duration = now() - started;
    console.log(`[VTID-04023] dev_run_sql_readonly thread=${opts.threadId || '-'} fp=${fp} kind=${v.kind} rows=${bounded.row_count}${bounded.truncated ? '+' : ''} ms=${duration}`);
    return { ...bounded, kind: v.kind, statement_fingerprint: fp, duration_ms: duration, read_only_transaction: true };
  } catch (err) {
    const duration = now() - started;
    console.warn(`[VTID-04023] dev_run_sql_readonly thread=${opts.threadId || '-'} fp=${fp} failed after ${duration}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
    client.release();
  }
}
