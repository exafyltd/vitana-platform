/**
 * VTID-01157: Supabase JWT Auth Middleware (Dev Onboarding MVP)
 * VTID-ORBC: Unified auth with dual JWT secrets (Platform + Lovable)
 * VTID-03827: Additive Cognito RS256/JWKS verification (Supabase Auth →
 *   Cognito migration — see infra/cognito-migration/README.md)
 *
 * Purpose: Verify Supabase HS256/ES256 JWT tokens (and, once configured,
 * Cognito RS256 ID tokens) and extract identity claims. Supports:
 *   1. SUPABASE_JWT_SECRET — Platform Supabase project (HS256)
 *   2. LOVABLE_JWT_SECRET  — Lovable Supabase project, temp_vitana_v1 (HS256)
 *   3. SUPABASE_AUTH_JWKS_URL — newer Supabase projects signing ES256
 *   4. COGNITO_USER_POOL_ID — Cognito User Pool issuing RS256 ID tokens
 *      (VTID-03827). Unset in every live task def today — this path is
 *      inert until a real pool exists and this var is deliberately set.
 *
 * Tries each configured source in order, HS256 first, then falls through.
 * Attaches auth_source to the request so downstream code knows which
 * identity provider signed the token.
 *
 * SECURITY: Does NOT call Supabase/Cognito to validate tokens - just
 * verifies signature + exp/nbf/iss/aud locally against the relevant key
 * material.
 */

import { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';
import { getSupabase } from '../lib/supabase';
import { upsertActiveDay } from '../services/guide/active-usage';
import * as repo from './auth-supabase-jwt-repository';

/**
 * Identity claims extracted from a validated Supabase JWT
 */
export interface SupabaseIdentity {
  user_id: string;          // From JWT 'sub' claim
  email: string | null;     // From JWT 'email' claim
  tenant_id: string | null; // From JWT 'app_metadata.active_tenant_id'
  exafy_admin: boolean;     // From JWT 'app_metadata.exafy_admin'
  role: string | null;      // From JWT 'role' claim (Supabase role, e.g., 'authenticated')
  aud: string | null;       // Audience claim
  exp: number | null;       // Expiration timestamp
  iat: number | null;       // Issued at timestamp
  // VTID-01967: Canonical Vitana ID — attached after JWT verify via cached
  // lookup against app_users (mirrored from profiles by Release A trigger).
  // Null-tolerant: undefined if the lookup hasn't run yet or the user has no
  // app_users row yet. Callers must never block on this.
  vitana_id?: string | null;
}

// VTID-01967: In-process cache for vitana_id lookup. Keyed by user_id, 5min TTL.
// Avoids hammering app_users on every authenticated request. Cleared lazily
// when entries are read after expiration.
const VITANA_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const vitanaIdCache = new Map<string, { vitana_id: string | null; expires_at: number }>();

/**
 * VTID-01967: Resolve vitana_id for a user, with in-process caching.
 * Returns null if not found / not yet mirrored — callers must be null-tolerant.
 * Public so callers (oasis-event-service, voice-message-guard) can resolve
 * the ID for a user_id outside the request lifecycle.
 */
export async function resolveVitanaId(userId: string): Promise<string | null> {
  if (!userId) return null;

  const cached = vitanaIdCache.get(userId);
  if (cached && cached.expires_at > Date.now()) {
    return cached.vitana_id;
  }

  try {
    const supabase = getSupabase();
    if (!supabase) return null;

    const { data } = await repo.fetchVitanaIdForUser(supabase, userId);

    const vitanaId = (data && (data as any).vitana_id) || null;
    vitanaIdCache.set(userId, {
      vitana_id: vitanaId,
      expires_at: Date.now() + VITANA_ID_CACHE_TTL_MS,
    });
    return vitanaId;
  } catch {
    // Null-tolerant: never block auth on this lookup. If the column doesn't
    // exist yet (Release A migrations not applied), the catch swallows.
    return null;
  }
}

/**
 * VTID-01967: Invalidate cached vitana_id for a user. Call this from the
 * /vitana-id/confirm endpoint after the user picks a different ID, so the
 * next authenticated request reads the new value.
 */
export function invalidateVitanaIdCache(userId: string): void {
  vitanaIdCache.delete(userId);
}

/**
 * Auth source: which identity provider signed the JWT
 */
export type AuthSource = 'platform' | 'lovable' | 'jwks' | 'cognito';

/**
 * Extended Express Request with identity attached
 */
export interface AuthenticatedRequest extends Request {
  identity?: SupabaseIdentity;
  auth_raw_claims?: jose.JWTPayload;
  auth_source?: AuthSource;
}

/**
 * Extract Bearer token from Authorization header.
 * @param req - Express request object
 * @returns The token string or null if not found/invalid format
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7); // Remove 'Bearer ' prefix
}

/**
 * VTID-ORBC: JWT secret sources — Platform first, Lovable second.
 * Returns array of { secret, source } to try in order.
 */
function getJwtSecrets(): Array<{ secret: Uint8Array; source: AuthSource }> {
  const secrets: Array<{ secret: Uint8Array; source: AuthSource }> = [];
  const platformSecret = process.env.SUPABASE_JWT_SECRET;
  const lovableSecret = process.env.LOVABLE_JWT_SECRET;

  if (platformSecret) {
    secrets.push({ secret: new TextEncoder().encode(platformSecret), source: 'platform' });
  }
  if (lovableSecret) {
    secrets.push({ secret: new TextEncoder().encode(lovableSecret), source: 'lovable' });
  }

  if (secrets.length === 0) {
    console.error('[VTID-ORBC] No JWT secrets configured (need SUPABASE_JWT_SECRET or LOVABLE_JWT_SECRET)');
  }

  return secrets;
}

/**
 * VTID-03292: ES256/asymmetric verification via a remote JWKS.
 *
 * Newer Supabase projects sign JWTs with ES256 (asymmetric "JWT signing keys")
 * instead of the legacy HS256 shared secret. The HS256 path above can't verify
 * those. When `SUPABASE_AUTH_JWKS_URL` is set (e.g. the staging project's
 * `/auth/v1/.well-known/jwks.json`), we additionally try ES256 verification
 * against that JWKS. ADDITIVE + gated: prod leaves the env unset and behaves
 * exactly as before. `createRemoteJWKSet` caches keys + auto-refreshes on
 * rotation, so this is a single lazily-created module-level set.
 */
let _remoteJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let _remoteJwksUrl: string | null = null;
function getRemoteJwks(): ReturnType<typeof jose.createRemoteJWKSet> | null {
  const url = process.env.SUPABASE_AUTH_JWKS_URL;
  if (!url) return null;
  if (_remoteJwks && _remoteJwksUrl === url) return _remoteJwks;
  try {
    _remoteJwks = jose.createRemoteJWKSet(new URL(url));
    _remoteJwksUrl = url;
    return _remoteJwks;
  } catch (e) {
    console.error(`[VTID-03292] Invalid SUPABASE_AUTH_JWKS_URL: ${(e as Error).message}`);
    return null;
  }
}

/**
 * VTID-03827: RS256 verification via a Cognito User Pool's JWKS.
 *
 * Additive + gated exactly like SUPABASE_AUTH_JWKS_URL above: unset in every
 * live task def today, so this is a no-op until COGNITO_USER_POOL_ID is
 * deliberately configured (see infra/cognito-migration/README.md for the
 * infra this verifies against, and its own "not yet applied" status).
 */
let _cognitoJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let _cognitoJwksKey: string | null = null;
function getCognitoJwks(): ReturnType<typeof jose.createRemoteJWKSet> | null {
  const poolId = process.env.COGNITO_USER_POOL_ID;
  if (!poolId) return null;
  const region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'eu-central-1';
  const key = `${region}/${poolId}`;
  if (_cognitoJwks && _cognitoJwksKey === key) return _cognitoJwks;
  try {
    const url = `https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`;
    _cognitoJwks = jose.createRemoteJWKSet(new URL(url));
    _cognitoJwksKey = key;
    return _cognitoJwks;
  } catch (e) {
    console.error(`[VTID-03827] Invalid Cognito JWKS config: ${(e as Error).message}`);
    return null;
  }
}

function cognitoIssuer(): string {
  const poolId = process.env.COGNITO_USER_POOL_ID;
  const region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'eu-central-1';
  return `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
}

/**
 * VTID-03827: Map a verified Cognito ID token payload to a SupabaseIdentity.
 *
 * `user_id` deliberately comes from the `custom:legacy_user_id` claim, NOT
 * from Cognito's own `sub` — Cognito assigns a fresh random UUID per user on
 * creation, but every FK, RLS policy, and app_users/user_tenants row in this
 * platform is keyed on the ORIGINAL Supabase auth.users.id. The Cognito User
 * Migration Lambda (infra/cognito-migration/lambda/index.js) is responsible
 * for populating that custom attribute from the legacy account at migration
 * time; the User Pool's admin_create_user_config.allow_admin_create_user_only
 * means the Lambda is currently the ONLY way a user is ever created, so this
 * claim should always be present in practice. Falling back to `sub` is a
 * defensive default for a malformed/unmigrated token, not an expected path.
 *
 * KNOWN GAP, not yet resolved: `exafy_admin` has no Cognito-side source of
 * truth yet (no custom claim/group has been defined) and is hardcoded false
 * here — a Cognito-authenticated admin will be denied by requireExafyAdmin/
 * requireAdminAuth until this gets either a custom claim populated by the
 * migration Lambda (mirroring legacy_user_id) or a DB-lookup fallback the
 * way requireTenant already does for tenant_id. Do not remove this comment
 * without actually fixing the gap.
 */
function extractCognitoIdentity(payload: jose.JWTPayload): SupabaseIdentity {
  const legacyUserId = (payload['custom:legacy_user_id'] as string) || payload.sub || '';
  return {
    user_id: legacyUserId,
    email: (payload.email as string) || null,
    tenant_id: null, // resolved via requireTenant's existing user_tenants DB fallback
    exafy_admin: false, // see KNOWN GAP above
    role: 'authenticated',
    aud: Array.isArray(payload.aud) ? payload.aud[0] : (payload.aud as string) || null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
    iat: typeof payload.iat === 'number' ? payload.iat : null,
  };
}

/**
 * Extract identity claims from a verified JWT payload.
 */
function extractIdentity(payload: jose.JWTPayload): SupabaseIdentity {
  const appMetadata = (payload.app_metadata as Record<string, unknown>) || {};
  return {
    user_id: payload.sub || '',
    email: (payload.email as string) || null,
    tenant_id: (appMetadata.active_tenant_id as string) || null,
    exafy_admin: appMetadata.exafy_admin === true,
    role: (payload.role as string) || null,
    aud: Array.isArray(payload.aud) ? payload.aud[0] : (payload.aud as string) || null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
    iat: typeof payload.iat === 'number' ? payload.iat : null,
  };
}

/**
 * VTID-ORBC: Verify a JWT against all configured secrets.
 * Tries SUPABASE_JWT_SECRET (Platform) first, then LOVABLE_JWT_SECRET (Lovable).
 * Returns identity + source on first successful verification.
 *
 * VTID-01224: Exported for WebSocket auth in orb-live.ts
 */
export async function verifyAndExtractIdentity(
  token: string
): Promise<{ identity: SupabaseIdentity; claims: jose.JWTPayload; auth_source: AuthSource } | null> {
  const secrets = getJwtSecrets();

  for (const { secret, source } of secrets) {
    try {
      const { payload } = await jose.jwtVerify(token, secret, {
        algorithms: ['HS256'],
      });
      const identity = extractIdentity(payload);
      console.log(`[VTID-ORBC] JWT verified via ${source} secret: user=${identity.user_id}`);
      return { identity, claims: payload, auth_source: source };
    } catch (_error: any) {
      // Continue to next secret
    }
  }

  // VTID-03292: HS256 secrets failed (or none configured) — try ES256 against
  // the remote JWKS when configured (staging Supabase signs with ES256).
  const jwks = getRemoteJwks();
  if (jwks) {
    try {
      const { payload } = await jose.jwtVerify(token, jwks, { algorithms: ['ES256'] });
      const identity = extractIdentity(payload);
      console.log(`[VTID-03292] JWT verified via JWKS (ES256): user=${identity.user_id}`);
      return { identity, claims: payload, auth_source: 'jwks' };
    } catch (_error: any) {
      // fall through to failure
    }
  }

  // VTID-03827: Supabase paths failed (or none configured) — try Cognito's
  // RS256 ID tokens when a pool is configured. Only accepts token_use='id'
  // (Cognito access tokens carry no email/custom claims, so the ID token is
  // what this platform's identity shape needs) and, when
  // COGNITO_APP_CLIENT_ID is set, checks aud matches that specific client.
  const cognitoJwks = getCognitoJwks();
  if (cognitoJwks) {
    try {
      const { payload } = await jose.jwtVerify(token, cognitoJwks, {
        algorithms: ['RS256'],
        issuer: cognitoIssuer(),
      });
      if (payload.token_use !== 'id') {
        throw new Error(`expected a Cognito ID token, got token_use=${payload.token_use}`);
      }
      const expectedClientId = process.env.COGNITO_APP_CLIENT_ID;
      if (expectedClientId && payload.aud !== expectedClientId) {
        throw new Error('aud does not match COGNITO_APP_CLIENT_ID');
      }
      const identity = extractCognitoIdentity(payload);
      console.log(`[VTID-03827] JWT verified via Cognito JWKS (RS256): user=${identity.user_id}`);
      return { identity, claims: payload, auth_source: 'cognito' };
    } catch (_error: any) {
      // fall through to failure
    }
  }

  if (secrets.length === 0 && !jwks && !cognitoJwks) {
    return null;
  }
  // All verification paths failed — log for debugging
  console.warn('[VTID-ORBC] JWT verification failed against all configured secrets + JWKS');
  return null;
}

/**
 * Middleware: Require valid Supabase JWT authentication.
 * Attaches req.identity and req.auth_raw_claims on success.
 * Returns 401 on missing/invalid token.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
    });
    return;
  }

  const result = await verifyAndExtractIdentity(token);

  if (!result) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Invalid or expired token',
    });
    return;
  }

  // Attach identity to request
  req.identity = result.identity;
  req.auth_raw_claims = result.claims;
  req.auth_source = result.auth_source;

  // BOOTSTRAP-DYK-TOUR: fire-and-forget active-day tracker for the usage-based
  // 30-day Did-You-Know tour. PK-deduped per (user_id, UTC date) — safe to spam.
  if (result.identity.user_id) {
    upsertActiveDay(result.identity.user_id).catch(() => {});
  }

  // VTID-01967: Resolve vitana_id (cached, null-tolerant). Downstream code
  // reads req.identity.vitana_id directly; on cache hit this is ~0ms.
  req.identity.vitana_id = await resolveVitanaId(result.identity.user_id);

  next();
}

/**
 * Middleware: Optional authentication.
 * Attaches req.identity if valid token present, but doesn't require it.
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getBearerToken(req);

  if (token) {
    const result = await verifyAndExtractIdentity(token);
    if (result) {
      req.identity = result.identity;
      req.auth_raw_claims = result.claims;
      req.auth_source = result.auth_source;
      if (result.identity.user_id) {
        upsertActiveDay(result.identity.user_id).catch(() => {});
      }
      // VTID-01967: vitana_id resolution
      req.identity.vitana_id = await resolveVitanaId(result.identity.user_id);
    }
  }

  next();
}

/**
 * Middleware: Require exafy_admin = true.
 * Must be used AFTER requireAuth middleware.
 * Returns 403 if user is not an exafy admin.
 */
export function requireExafyAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.identity) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
    return;
  }

  if (!req.identity.exafy_admin) {
    console.warn(
      `[VTID-01157] Access denied: user ${req.identity.user_id} is not exafy_admin`
    );
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'This endpoint requires exafy_admin privileges',
    });
    return;
  }

  next();
}

/**
 * VTID-01186: Middleware: Require tenant_id in JWT.
 * Must be used AFTER requireAuth middleware.
 * Returns 400 if tenant_id is null/missing in JWT app_metadata.
 */
export async function requireTenant(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.identity) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
    return;
  }

  // If tenant_id missing from JWT, resolve from user_tenants table
  if (!req.identity.tenant_id) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data: tenantRow } = await repo.fetchPrimaryTenantForUser(supabase, req.identity.user_id);

        if (tenantRow?.tenant_id) {
          req.identity.tenant_id = tenantRow.tenant_id;
          console.log(
            `[VTID-01186] Resolved tenant from user_tenants for user ${req.identity.user_id}: ${tenantRow.tenant_id}`
          );
        }
      } catch (err: any) {
        console.warn(
          `[VTID-01186] Failed to resolve tenant from DB for user ${req.identity.user_id}: ${err.message}`
        );
      }
    }
  }

  if (!req.identity.tenant_id) {
    console.warn(
      `[VTID-01186] Tenant required: user ${req.identity.user_id} has no active_tenant_id in JWT`
    );
    res.status(400).json({
      ok: false,
      error: 'TENANT_REQUIRED',
      message: 'No active_tenant_id in JWT app_metadata. Please select an active tenant.',
    });
    return;
  }

  next();
}

/**
 * VTID-01186: Combined middleware: requireAuth + requireTenant
 * Convenience middleware for routes that require both auth and tenant.
 */
export async function requireAuthWithTenant(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
    });
    return;
  }

  const result = await verifyAndExtractIdentity(token);

  if (!result) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Invalid or expired token',
    });
    return;
  }

  req.identity = result.identity;
  req.auth_raw_claims = result.claims;
  req.auth_source = result.auth_source;

  // BOOTSTRAP-DYK-TOUR: active-day tracker for the tour curriculum
  if (result.identity.user_id) {
    upsertActiveDay(result.identity.user_id).catch(() => {});
  }

  // VTID-01967: vitana_id resolution
  req.identity.vitana_id = await resolveVitanaId(result.identity.user_id);

  // If tenant_id missing from JWT, resolve from user_tenants table
  if (!req.identity.tenant_id) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data: tenantRow } = await repo.fetchPrimaryTenantForUser(supabase, req.identity.user_id);

        if (tenantRow?.tenant_id) {
          req.identity.tenant_id = tenantRow.tenant_id;
          console.log(
            `[VTID-01186] Resolved tenant from user_tenants for user ${req.identity.user_id}: ${tenantRow.tenant_id}`
          );
        }
      } catch (err: any) {
        console.warn(
          `[VTID-01186] Failed to resolve tenant from DB for user ${req.identity.user_id}: ${err.message}`
        );
      }
    }
  }

  // Still no tenant after DB lookup → reject
  if (!req.identity.tenant_id) {
    console.warn(
      `[VTID-01186] Tenant required: user ${req.identity.user_id} has no active_tenant_id`
    );
    res.status(400).json({
      ok: false,
      error: 'TENANT_REQUIRED',
      message: 'No active_tenant_id in JWT app_metadata. Please select an active tenant.',
    });
    return;
  }

  next();
}

/**
 * Combined middleware: requireAuth + requireExafyAdmin
 * Convenience middleware for routes that require both.
 */
export async function requireAdminAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // First, require valid auth
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
    });
    return;
  }

  const result = await verifyAndExtractIdentity(token);

  if (!result) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Invalid or expired token',
    });
    return;
  }

  req.identity = result.identity;
  req.auth_raw_claims = result.claims;
  req.auth_source = result.auth_source;

  // BOOTSTRAP-DYK-TOUR: active-day tracker for the tour curriculum
  if (result.identity.user_id) {
    upsertActiveDay(result.identity.user_id).catch(() => {});
  }

  // VTID-01967: vitana_id resolution
  req.identity.vitana_id = await resolveVitanaId(result.identity.user_id);

  // Then, require exafy_admin
  if (!req.identity.exafy_admin) {
    console.warn(
      `[VTID-01157] Access denied: user ${req.identity.user_id} is not exafy_admin`
    );
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'This endpoint requires exafy_admin privileges',
    });
    return;
  }

  next();
}
