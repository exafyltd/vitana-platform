/**
 * Aurora <-> Supabase reconciliation (VTID-03611 follow-up).
 *
 * Standalone, deliberately outside the i18n-scoped `db-i18n/aurora-client.ts`
 * seam (VTID-03517) -- this checks arbitrary tables (oasis_events, vtid_ledger,
 * worker_registry, etc.), not just the two DMS-replicated i18n tables that
 * module was built for. Read-only both sides. Does not require the gateway's
 * i18n write-gate (`AURORA_I18N_WRITES`) because it never writes anything.
 *
 * WHY THIS EXISTS: docs/AWS-CUTOVER-RUNBOOK.md and CLAUDE.md §1b both cite an
 * unreconciled ~154k silently-dropped DMS row-apply gap discovered during
 * VTID-03419 (2026-07-27) and never closed. Before treating Aurora as a valid
 * failover target for ANY service (oasis-projector, worker-runner, etc.), the
 * actual current drift between the two databases has to be measured, not
 * assumed healthy from an old runbook checkbox.
 *
 * WHAT IT DOES
 *   1. Row-count comparison per table, both databases.
 *   2. A whole-table checksum: md5(string_agg(md5(t::text), '' ORDER BY t::text))
 *      -- deliberately ordered by the row's own text representation rather than
 *      a named primary key, so this works across tables with different PK
 *      column names/types without per-table config. This costs a full table
 *      scan + sort on both sides; fine for a manual reconciliation run, not
 *      meant to run on a schedule against large tables without LIMIT/paging.
 *   3. Prints a per-table PASS/MISMATCH/ERROR verdict and a summary count.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - No writes, no repair, no DMS control-plane calls.
 *   - No table list is hardcoded as "the" reconciliation set -- pass tables
 *     via --tables or default to a short, explicit list of the tables that
 *     actually matter for the oasis-projector/worker-runner AWS-primary
 *     question. Silently reconciling "everything" would produce a report
 *     nobody could act on inside a time-boxed window.
 *
 * USAGE
 *   AURORA_DATABASE_URL=postgres://...   (Aurora reader or writer endpoint)
 *   SUPABASE_DATABASE_URL=postgres://... (direct Postgres connection, NOT the
 *                                          PostgREST URL -- Supabase project
 *                                          settings -> Database -> Connection
 *                                          string -> URI, "Session" mode)
 *   tsx services/gateway/scripts/reconciliation/aurora-supabase-reconcile.ts \
 *     --tables oasis_events,vtid_ledger,worker_registry
 *
 *   Optional: --since-hours 24   (restricts oasis_events-style tables with a
 *     created_at column to recent rows only -- full-table checksums on a
 *     multi-million-row event log are not a 30-minute-window operation)
 */

import { Pool, type PoolConfig } from 'pg';
import { readFileSync, existsSync } from 'node:fs';

interface DbTarget {
  name: 'aurora' | 'supabase';
  pool: Pool;
}

function resolveSsl(urlEnvVar: string, url: string, caPathEnvVar: string, insecureEnvVar: string): PoolConfig['ssl'] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${urlEnvVar} is not a valid URL.`);
  }
  const sslmode = parsed.searchParams.get('sslmode');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (sslmode === 'disable') {
    if (isLoopback) {
      console.warn(`[reconcile] ${urlEnvVar}: sslmode=disable on loopback -- plaintext (local/test only).`);
      return false;
    }
    throw new Error(
      `${urlEnvVar}: sslmode=disable is only permitted for loopback hosts, and ${JSON.stringify(host)} is not one. ` +
        `Set ${caPathEnvVar} instead, or ${insecureEnvVar}=true if you must skip verification.`,
    );
  }
  const caPath = (process.env[caPathEnvVar] ?? '').trim();
  if (caPath) {
    if (!existsSync(caPath)) {
      throw new Error(`${caPathEnvVar}=${JSON.stringify(caPath)} but no such file exists.`);
    }
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  if ((process.env[insecureEnvVar] ?? '').trim().toLowerCase() === 'true') {
    console.warn(`[reconcile] ${insecureEnvVar}=true -- TLS verification DISABLED for ${urlEnvVar}.`);
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

function buildPool(urlEnvVar: string, caPathEnvVar: string, insecureEnvVar: string): Pool {
  const url = (process.env[urlEnvVar] ?? '').trim();
  if (!url) {
    throw new Error(`${urlEnvVar} is not set.`);
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(`${urlEnvVar} must be a postgres:// or postgresql:// URL.`);
  }
  return new Pool({
    connectionString: url,
    ssl: resolveSsl(urlEnvVar, url, caPathEnvVar, insecureEnvVar),
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: 'vitana-aurora-supabase-reconcile',
  });
}

interface TableResult {
  table: string;
  auroraCount: number | null;
  supabaseCount: number | null;
  auroraChecksum: string | null;
  supabaseChecksum: string | null;
  verdict: 'PASS' | 'COUNT_MISMATCH' | 'CHECKSUM_MISMATCH' | 'ERROR';
  detail: string;
}

async function countAndChecksum(
  pool: Pool,
  table: string,
  sinceHours: number | null,
): Promise<{ count: number; checksum: string }> {
  const whereClause = sinceHours != null ? `WHERE created_at >= now() - interval '${sinceHours} hours'` : '';
  const countRes = await pool.query(`SELECT count(*)::bigint AS n FROM ${table} ${whereClause}`);
  const count = Number(countRes.rows[0].n);
  if (count === 0) {
    return { count: 0, checksum: 'EMPTY' };
  }
  const checksumRes = await pool.query(
    `SELECT md5(string_agg(md5(t::text), '' ORDER BY t::text)) AS checksum FROM ${table} t ${whereClause}`,
  );
  return { count, checksum: checksumRes.rows[0].checksum as string };
}

async function reconcileTable(
  aurora: Pool,
  supabase: Pool,
  table: string,
  sinceHours: number | null,
): Promise<TableResult> {
  const base: TableResult = {
    table,
    auroraCount: null,
    supabaseCount: null,
    auroraChecksum: null,
    supabaseChecksum: null,
    verdict: 'ERROR',
    detail: '',
  };
  let auroraSide: { count: number; checksum: string } | null = null;
  let supabaseSide: { count: number; checksum: string } | null = null;
  try {
    auroraSide = await countAndChecksum(aurora, table, sinceHours);
    base.auroraCount = auroraSide.count;
    base.auroraChecksum = auroraSide.checksum;
  } catch (err) {
    base.detail += `aurora: ${(err as Error).message}. `;
  }
  try {
    supabaseSide = await countAndChecksum(supabase, table, sinceHours);
    base.supabaseCount = supabaseSide.count;
    base.supabaseChecksum = supabaseSide.checksum;
  } catch (err) {
    base.detail += `supabase: ${(err as Error).message}. `;
  }
  if (auroraSide === null || supabaseSide === null) {
    base.verdict = 'ERROR';
    return base;
  }
  if (auroraSide.count !== supabaseSide.count) {
    base.verdict = 'COUNT_MISMATCH';
    base.detail = `aurora=${auroraSide.count} supabase=${supabaseSide.count} (delta=${supabaseSide.count - auroraSide.count})`;
    return base;
  }
  if (auroraSide.checksum !== supabaseSide.checksum) {
    base.verdict = 'CHECKSUM_MISMATCH';
    base.detail = `same row count (${auroraSide.count}) but content differs -- rows exist on both sides but do not match byte-for-byte`;
    return base;
  }
  base.verdict = 'PASS';
  base.detail = `${auroraSide.count} rows, identical`;
  return base;
}

function parseArgs(argv: string[]): { tables: string[]; sinceHours: number | null } {
  const tablesArg = argv.find((a) => a.startsWith('--tables='))?.split('=')[1];
  const sinceArg = argv.find((a) => a.startsWith('--since-hours='))?.split('=')[1];
  const DEFAULT_TABLES = ['oasis_events', 'vtid_ledger', 'worker_registry'];
  return {
    tables: tablesArg ? tablesArg.split(',').map((t) => t.trim()).filter(Boolean) : DEFAULT_TABLES,
    sinceHours: sinceArg ? Number(sinceArg) : null,
  };
}

async function main() {
  const { tables, sinceHours } = parseArgs(process.argv.slice(2));
  console.log(`[reconcile] tables: ${tables.join(', ')}`);
  console.log(`[reconcile] since-hours: ${sinceHours ?? '(full table)'}`);
  console.log('[reconcile] NOTE: full-table checksums without --since-hours can be slow/expensive on large tables.');

  let aurora: Pool;
  let supabase: Pool;
  try {
    aurora = buildPool('AURORA_DATABASE_URL', 'AURORA_CA_BUNDLE_PATH', 'AURORA_SSL_INSECURE');
  } catch (err) {
    console.error(`[reconcile] FATAL: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  try {
    supabase = buildPool('SUPABASE_DATABASE_URL', 'SUPABASE_CA_BUNDLE_PATH', 'SUPABASE_SSL_INSECURE');
  } catch (err) {
    console.error(`[reconcile] FATAL: ${(err as Error).message}`);
    await aurora.end();
    process.exitCode = 2;
    return;
  }

  const results: TableResult[] = [];
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      results.push({
        table,
        auroraCount: null,
        supabaseCount: null,
        auroraChecksum: null,
        supabaseChecksum: null,
        verdict: 'ERROR',
        detail: 'refused: table name fails identifier allowlist (letters/digits/underscore only) -- not interpolating unsafe input into SQL',
      });
      continue;
    }
    // Table names cannot be parameterized in pg -- validated above with a strict
    // identifier allowlist before interpolation, same pattern as the rest of this
    // repo's admin/reconciliation scripts.
    const r = await reconcileTable(aurora, supabase, table, sinceHours);
    results.push(r);
    console.log(`[reconcile] ${table}: ${r.verdict} -- ${r.detail}`);
  }

  await aurora.end();
  await supabase.end();

  const mismatches = results.filter((r) => r.verdict !== 'PASS');
  console.log('');
  console.log('=== SUMMARY ===');
  for (const r of results) {
    console.log(`  ${r.verdict.padEnd(17)} ${r.table}`);
  }
  console.log('');
  if (mismatches.length > 0) {
    console.log(`${mismatches.length} of ${results.length} table(s) DID NOT reconcile cleanly.`);
    console.log('Treat Aurora as NOT a safe failover target for any of the mismatched tables until resolved.');
    process.exitCode = 1;
  } else {
    console.log(`All ${results.length} table(s) reconciled cleanly (row-count + full-content checksum match).`);
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error('[reconcile] unhandled error:', err);
  process.exitCode = 2;
});
