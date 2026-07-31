/**
 * VTID-03450: Service-role (admin) pooled connection to Aurora Postgres.
 *
 * Mirrors getSupabase() in supabase.ts, but for the AWS DB-migration path --
 * a direct `pg` connection to vitana-aurora-prod instead of the Supabase
 * REST/RPC client. This bypasses RLS entirely (connects as the table-owning
 * role), so it is only for governance/system-level operations that
 * legitimately need cross-tenant access. Anything scoped to a single
 * authenticated user must go through withUserClaims() in aurora-user.ts.
 */

import { Pool } from 'pg';

let pool: Pool | null = null;

export function getAuroraPool(): Pool | null {
  if (pool) return pool;

  const connectionString = process.env.AURORA_DATABASE_URL;
  if (!connectionString) {
    console.error('[Aurora] Configuration missing: AURORA_DATABASE_URL not set.');
    return null;
  }

  pool = new Pool({
    connectionString,
    max: Number(process.env.AURORA_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    // Aurora enforces SSL by default outside the VPC; harmless to require it
    // from inside the VPC too. Set AURORA_SSL_DISABLE=true only for local dev
    // against a non-TLS Postgres.
    ssl: process.env.AURORA_SSL_DISABLE === 'true' ? false : { rejectUnauthorized: true },
  });

  pool.on('error', (err) => {
    console.error('[Aurora] Idle client error', err);
  });

  return pool;
}
