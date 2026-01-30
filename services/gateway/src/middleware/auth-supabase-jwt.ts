/**
 * VTID-01157: Supabase JWT Auth Middleware (Dev Onboarding MVP)
 *
 * Purpose: Verify Supabase HS256 JWT tokens and extract identity claims.
 * This middleware validates the JWT signature using SUPABASE_JWT_SECRET
 * and attaches identity information to the request object.
 *
 * SECURITY: Does NOT call Supabase to validate tokens - just verifies signature + exp/nbf.
 */

import { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';

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
}

/**
 * Extended Express Request with identity attached
 */
export interface AuthenticatedRequest extends Request {
  identity?: SupabaseIdentity;
  auth_raw_claims?: jose.JWTPayload;
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
 * Get the JWT secret from environment.
 * Supabase uses HS256 with a shared secret.
 */
function getJwtSecret(): Uint8Array | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('[VTID-01157] SUPABASE_JWT_SECRET not configured');
    return null;
  }
  return new TextEncoder().encode(secret);
}

/**
 * Verify a Supabase JWT and extract identity claims.
 * @param token - The JWT string
 * @returns Identity object or null if verification fails
 *
 * VTID-01223: Exported for WebSocket auth in orb-live.ts
 */
export async function verifyAndExtractIdentity(
  token: string
): Promise<{ identity: SupabaseIdentity; claims: jose.JWTPayload } | null> {
  const secret = getJwtSecret();
  if (!secret) {
    return null;
  }

  try {
    // Verify JWT signature, expiration, and not-before
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    // Extract identity from claims
    const appMetadata = (payload.app_metadata as Record<string, unknown>) || {};

    const identity: SupabaseIdentity = {
      user_id: payload.sub || '',
      email: (payload.email as string) || null,
      tenant_id: (appMetadata.active_tenant_id as string) || null,
      exafy_admin: appMetadata.exafy_admin === true,
      role: (payload.role as string) || null,
      aud: Array.isArray(payload.aud) ? payload.aud[0] : (payload.aud as string) || null,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
      iat: typeof payload.iat === 'number' ? payload.iat : null,
    };

    return { identity, claims: payload };
  } catch (error: any) {
    // Log verification failures for debugging
    if (error.code === 'ERR_JWT_EXPIRED') {
      console.warn('[VTID-01157] JWT expired');
    } else if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      console.warn('[VTID-01157] JWT signature verification failed');
    } else {
      console.warn('[VTID-01157] JWT verification failed:', error.message);
    }
    return null;
  }
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
export function requireTenant(
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

  // Require tenant_id
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
