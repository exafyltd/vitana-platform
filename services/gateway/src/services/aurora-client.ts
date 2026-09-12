/**
 * VTID-03591 — Supabase -> Aurora application-layer cutover, Phase B4.
 *
 * A direct Postgres connection to Aurora, with a per-request helper that
 * makes existing RLS policies evaluate identically to how PostgREST runs
 * them today. See scripts/aurora/migrations/0000_auth_roles.sql and
 * 0001_auth_shim.sql for the DB-side half of this (roles + auth.uid()/
 * auth.jwt()/auth.role()/auth.email() shims, copied byte-for-byte from
 * production via pg_get_functiondef()).
 *
 * Wired into exactly one route (GET /api/v1/admin/aurora-rls-health,
 * VTID-03591) and nowhere else. getAuroraPool() returns null until
 * AURORA_RLS_DATABASE_URL is set, mirroring getSupabase()'s null-tolerant
 * pattern in lib/supabase.ts.
 *
 * VTID-03813/2026-09-10 — deliberately a DIFFERENT env var from
 * AURORA_DATABASE_URL (services/db-i18n/aurora-client.ts, VTID-03517/03773).
 * That module's connection string resolves to the `vitana_admin` secret
 * (`vitana/aurora/prod/database-url`) — a superuser-class login role, correct
 * for its own DB-content-i18n writes but WRONG here: this module's entire
 * purpose is proving RLS composes correctly for a non-superuser role, and a
 * superuser connection would make the health check permanently report
 * "unsafe" regardless of whether RLS actually works. AURORA_RLS_DATABASE_URL
 * points instead at the unprivileged `authenticator` role
 * (`vitana/aurora/prod/postgrest-authenticator-uri`), verified live
 * (VTID-03769) to have rolsuper=false/rolbypassrls=false.
 *
 * How PostgREST does this (what we're reproducing): on every request it
 * opens a transaction, runs `SET LOCAL ROLE <jwt role>` and
 * `SET LOCAL request.jwt.claims = '<raw jwt payload>'`, then the actual
 * query — so `auth.uid()` etc. read those session GUCs. We do the same
 * thing explicitly here, from claims the gateway already validated via
 * verifyAndExtractIdentity() (middleware/auth-supabase-jwt.ts) for its own
 * purposes.
 *
 * Two things this used to depend on, now VERIFIED against live Aurora
 * (VTID-03768/VTID-03769, 2026-08-27 — see docs/AURORA-B4-SIZING-REFRESH.md's
 * two addenda for the full transcript):
 *   1. The `authenticator` role (login-capable, the same role name/purpose
 *      PostgREST itself connects as against Supabase) has rolsuper=false
 *      and rolbypassrls=false, and is GRANTed membership in anon/
 *      authenticated/service_role — confirmed live via pg_roles. Only
 *      `service_role` itself has BYPASSRLS (matching Supabase exactly),
 *      so a connection authenticating as `authenticator` and doing
 *      `SET LOCAL ROLE authenticated` is subject to RLS as expected.
 *   2. `SET LOCAL ROLE authenticated`/`anon`/`service_role` no longer fails
 *      with "permission denied to set role" — 0000_auth_roles.sql's
 *      trailing GRANT (this file's comment above) has been applied for
 *      real against `authenticator` (not left commented out).
 *      `scripts/aws/setup-aurora-postgrest-grants.sh --apply` additionally
 *      closed a THIRD gap the original two-item list above didn't know to
 *      list: `authenticated`/`anon`/`service_role` had no `GRANT USAGE ON
 *      SCHEMA public` at all (DMS carries table structure/data, not GRANT
 *      DDL), so even a correctly-SET-ROLE'd connection got "permission
 *      denied for schema public" on every query regardless of RLS. Fixed
 *      and verified end-to-end: a real `SET ROLE authenticated` + `SELECT
 *      count(*) FROM public.diary_entries` inside one RDS Data API
 *      transaction returned `0` (not an error) with no
 *      `request.jwt.claim.sub` set — i.e. RLS correctly excluded every row
 *      rather than either erroring or (worse) silently returning all of
 *      them.
 *
 * Caveat this verification does NOT close: everything above was exercised
 * over the RDS Data API (HTTPS) from a sandboxed session with no VPC
 * route to Aurora's raw Postgres port. This module's own `pg.Pool` /
 * `AURORA_RLS_DATABASE_URL` code path — the actual transport a real gateway
 * route would use — has never itself been exercised end-to-end from any
 * Claude Code session for that same network reason. The DB-side mechanism
 * is proven; this file's own `pg.Pool` call site touching it is not, yet.
 * Wiring `withAuroraRlsContext()` into an actual route remains the open
 * item (tracked in the VTID-03769 commit message and the B4-sizing doc).
 */

import { Pool, PoolClient } from 'pg';
import type { JWTPayload } from 'jose';
import { readFileSync, existsSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

/**
 * TLS for Aurora/RDS Proxy. Mirrors the fix in
 * services/db-i18n/aurora-client.ts (VTID-03798, live staging finding
 * 2026-08-29): `AURORA_DATABASE_URL`/`AURORA_RLS_DATABASE_URL` both point at
 * the RDS Proxy endpoint, not the Aurora cluster directly, and the proxy's
 * certificate chain does not terminate solely in the RDS CA bundle — it can
 * chain through a publicly-trusted root too. A naive `ca: [bundle]` REPLACES
 * Node's default trust store rather than extending it, which silently drops
 * that public root. Verifying against the union of the RDS bundle (needed
 * for a direct-to-instance connection) and Node's own `tls.rootCertificates`
 * (needed for the proxy's chain) fixes this without weakening verification —
 * `rejectUnauthorized` stays true either way. Falling back to
 * `rejectUnauthorized: false` (this module's original shape before this
 * fix) was a real bug: it accepts ANY certificate, defeating TLS entirely.
 */
function splitPemCertificates(bundle: string): string[] {
  const matches = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches ?? [];
}

function resolveAuroraSsl(): { rejectUnauthorized: true; ca: string[] } | undefined {
  if (process.env.AURORA_SSL === 'false') return undefined;
  const caPath = (process.env.AURORA_CA_BUNDLE_PATH ?? '').trim();
  const bundleCerts = caPath && existsSync(caPath) ? splitPemCertificates(readFileSync(caPath, 'utf8')) : [];
  if (caPath && bundleCerts.length === 0) {
    console.warn(`[Aurora] AURORA_CA_BUNDLE_PATH="${caPath}" set but no PEM certificates found in it — verifying against Node's built-in roots only.`);
  }
  return { rejectUnauthorized: true, ca: [...bundleCerts, ...rootCertificates] };
}

let pool: Pool | null = null;
let poolInitAttempted = false;

/** Roles actually referenced by public-schema RLS policies as of 2026-08-11
 *  (confirmed via pg_policies on production — no other role name appears).
 *  Kept as a strict allowlist: the JWT's `role` claim ultimately came from
 *  Supabase auth and is trustworthy, but `SET LOCAL ROLE <x>` can't be
 *  parameterized like a value, so we refuse to interpolate anything outside
 *  this set rather than trust string-building an identifier. */
const KNOWN_ROLES = new Set(['anon', 'authenticated', 'service_role']);

export function getAuroraPool(): Pool | null {
  if (pool) return pool;
  if (poolInitAttempted) return null; // don't retry-construct every call once we know it's unconfigured
  poolInitAttempted = true;

  const connectionString = process.env.AURORA_RLS_DATABASE_URL;
  if (!connectionString) {
    console.warn('[Aurora] AURORA_RLS_DATABASE_URL not set — Aurora client unavailable (expected until B4/B8 cutover).');
    return null;
  }

  pool = new Pool({
    connectionString,
    // ECS Fargate reaches Aurora over the VPC directly (unlike this Claude
    // session's sandbox, which has no VPC route and had to use RDS Data API
    // for read-only investigation instead).
    ssl: resolveAuroraSsl(),
    max: Number(process.env.AURORA_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (err) => {
    // Idle-client background errors — must be handled or an unhandled
    // 'error' event crashes the process (documented node-pg footgun).
    console.error('[Aurora] Idle pool client error:', err);
  });

  return pool;
}

export interface AuroraRlsContext {
  /** Raw JWT payload — serialized verbatim into request.jwt.claims, same as
   *  PostgREST forwards it. Pass verifyAndExtractIdentity()'s `claims`. */
  claims: JWTPayload | null;
  /** JWT `role` claim, e.g. 'authenticated' or 'service_role'. Falls back to
   *  no SET ROLE (connection's default privileges) if null/unrecognized —
   *  callers needing service_role-equivalent access must pass it explicitly
   *  rather than relying on a silent default. */
  role?: string | null;
}

/**
 * Runs `fn` inside a transaction with request.jwt.claims (and, if
 * recognized, role) set exactly as PostgREST would for the equivalent
 * request — so RLS policies written against auth.uid()/auth.jwt()/
 * auth.role() evaluate the same way against Aurora as they do today
 * against Supabase. Always transactional: SET LOCAL is scoped to the
 * transaction, and there is no reason to run RLS-governed queries outside
 * one anyway.
 */
export async function withAuroraRlsContext<T>(
  ctx: AuroraRlsContext,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const p = getAuroraPool();
  if (!p) {
    throw new Error('[Aurora] getAuroraPool() returned null — AURORA_RLS_DATABASE_URL not configured');
  }

  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // set_config(..., true) is the parameterized equivalent of
    // `SET LOCAL request.jwt.claims = '...'` — using it (not string-built
    // SQL) matters because claims are JSON containing arbitrary user data
    // (email, etc.) that must never be interpolated into a query string.
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      ctx.claims ? JSON.stringify(ctx.claims) : '',
    ]);

    if (ctx.role && KNOWN_ROLES.has(ctx.role)) {
      // Identifier, not a value — can't bind as a parameter. Safe here only
      // because it's checked against KNOWN_ROLES immediately above, not
      // because it's quoted or escaped.
      await client.query(`SET LOCAL ROLE ${ctx.role}`);
    } else if (ctx.role) {
      console.warn(`[Aurora] Unrecognized role claim "${ctx.role}" — not applying SET LOCAL ROLE, connection keeps its default privileges.`);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // ROLLBACK itself failing shouldn't mask the original error
    throw err;
  } finally {
    client.release();
  }
}

/** Direct query with no RLS context — for service_role-equivalent internal
 *  use only (mirrors how this codebase already uses SUPABASE_SERVICE_ROLE
 *  for worker/gateway-internal writes today). Do not use this for anything
 *  driven by a user request; use withAuroraRlsContext instead so tenant
 *  isolation actually applies. */
export async function auroraServiceQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const p = getAuroraPool();
  if (!p) {
    throw new Error('[Aurora] getAuroraPool() returned null — AURORA_RLS_DATABASE_URL not configured');
  }
  const { rows } = await p.query(sql, params);
  return rows;
}
