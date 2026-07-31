/**
 * VTID-03450: RLS claims-injection for direct-to-Aurora, user-scoped queries.
 *
 * Supabase's PostgREST layer sets `request.jwt.claims` (and the legacy
 * `request.jwt.claim.*` GUCs) from the caller's Authorization header on every
 * request -- that's what auth.uid()/auth.jwt() in RLS policies actually read.
 * Aurora has no PostgREST in front of it, so a direct Postgres connection has
 * to set those same session variables itself, per-transaction, before running
 * any user-scoped query. Skip this and auth.uid() resolves to NULL and every
 * RLS policy denies -- or, if connected as the table-owning role, RLS is
 * bypassed entirely and silently returns everything. (Verified live against
 * vitana-aurora-prod: the master/owner credential returns all rows regardless
 * of claims -- see assertNotBypassingRls below.)
 *
 * `claims` must be the full verified JWT payload from verifyAndExtractIdentity()
 * (auth-supabase-jwt.ts), not a reconstructed subset -- policies such as the
 * `profiles` table's admin check reference nested claims
 * (auth.jwt() -> 'app_metadata' ->> 'exafy_admin') that a partial object would
 * silently break.
 *
 * A bare pooled client can't be handed back to the caller the way
 * createUserSupabaseClient() hands back a long-lived Supabase client:
 * set_config(..., true) scopes to the current transaction only, so the
 * connection must stay pinned to one transaction for the claims to mean
 * anything. Hence the callback shape.
 */

import type { PoolClient } from 'pg';
import type { JWTPayload } from 'jose';
import { getAuroraPool } from './aurora';

let ownerBypassChecked = false;

/**
 * Refuses to proceed if the connected role bypasses RLS (superuser, or
 * rolbypassrls=true -- which includes plain table ownership in the common
 * case where AURORA_DATABASE_URL points at the same role that owns the
 * tables). Checked once per process, not per call, since the connection
 * string doesn't change at runtime.
 */
async function assertNotBypassingRls(client: PoolClient): Promise<void> {
  if (ownerBypassChecked) return;

  const { rows } = await client.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
    `select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user`
  );
  const row = rows[0];

  if (!row) {
    throw new Error('[Aurora] Could not resolve current_user against pg_roles.');
  }

  if (row.rolbypassrls || row.rolsuper) {
    throw new Error(
      `[Aurora] Refusing to run user-scoped queries as role "${row.rolname}" -- ` +
      `it bypasses RLS entirely (rolbypassrls=${row.rolbypassrls}, superuser=${row.rolsuper}). ` +
      `AURORA_DATABASE_URL for user-scoped queries must authenticate as a low-privilege ` +
      `role (e.g. "authenticated"), never the table-owning admin credential.`
    );
  }

  ownerBypassChecked = true;
}

/**
 * Runs `fn` against Aurora inside a transaction with the caller's verified
 * JWT claims injected into the session, so RLS policies relying on
 * auth.uid()/auth.jwt()/auth.role()/auth.email() evaluate exactly as they do
 * under Supabase's PostgREST today.
 */
export async function withUserClaims<T>(
  claims: JWTPayload,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getAuroraPool();
  if (!pool) {
    throw new Error('[Aurora] Pool unavailable -- AURORA_DATABASE_URL not configured.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertNotBypassingRls(client);

    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    const role = typeof claims.role === 'string' ? claims.role : 'authenticated';
    const email = typeof claims.email === 'string' ? claims.email : '';

    // set_config(..., true) scopes to the current transaction only (mirrors
    // PostgREST's per-request semantics) -- never leaks across pooled
    // connections once released back to the pool after COMMIT/ROLLBACK.
    await client.query(
      `select
         set_config('request.jwt.claims', $1, true),
         set_config('request.jwt.claim.sub', $2, true),
         set_config('request.jwt.claim.role', $3, true),
         set_config('request.jwt.claim.email', $4, true)`,
      [JSON.stringify(claims), sub, role, email]
    );

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
