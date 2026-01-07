/**
 * VTID-01171: Auth Me Endpoint
 *
 * GET /api/v1/auth/me - Returns authenticated user identity from JWT
 *
 * This endpoint:
 * 1. Verifies Supabase JWT (HS256) using SUPABASE_JWT_SECRET
 * 2. Returns identity from JWT claims (no database lookups required)
 * 3. Optionally fetches profile/memberships via RLS if available
 *
 * Response shape:
 * {
 *   ok: true,
 *   identity: {
 *     user_id: string,      // JWT sub
 *     email: string,
 *     tenant_id?: string,   // app_metadata.active_tenant_id
 *     exafy_admin: boolean
 *   },
 *   profile?: {
 *     display_name?: string,
 *     avatar_url?: string
 *   },
 *   memberships?: Array<{
 *     tenant_id: string,
 *     role: string,
 *     status: string
 *   }>
 * }
 */

import { Router, Request, Response } from 'express';
import { createHmac } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();

/**
 * Base64URL decode (JWT uses base64url encoding, not standard base64)
 */
function base64UrlDecode(input: string): string {
  // Replace URL-safe characters with standard base64 characters
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  const padding = base64.length % 4;
  if (padding) {
    base64 += '='.repeat(4 - padding);
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Verify Supabase JWT signature (HS256)
 * @param token - The JWT token string
 * @param secret - The SUPABASE_JWT_SECRET
 * @returns Decoded payload if valid, null if invalid
 */
function verifySupabaseJwt(token: string, secret: string): any | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.warn('[VTID-01171] Invalid JWT format: expected 3 parts');
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature using HS256
    const signatureInput = `${headerB64}.${payloadB64}`;
    const expectedSignature = createHmac('sha256', secret)
      .update(signatureInput)
      .digest('base64url');

    // Compare signatures (timing-safe comparison would be better, but acceptable for now)
    if (signatureB64 !== expectedSignature) {
      console.warn('[VTID-01171] JWT signature verification failed');
      return null;
    }

    // Decode and parse payload
    const payload = JSON.parse(base64UrlDecode(payloadB64));

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.warn('[VTID-01171] JWT expired');
      return null;
    }

    return payload;
  } catch (err: any) {
    console.error('[VTID-01171] JWT verification error:', err.message);
    return null;
  }
}

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7); // Remove 'Bearer ' prefix
}

/**
 * GET /api/v1/auth/me
 *
 * Returns authenticated user identity and optionally profile/memberships.
 * Verifies JWT directly using SUPABASE_JWT_SECRET (no RPC required).
 */
router.get('/', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token) {
    console.warn('[VTID-01171] GET /api/v1/auth/me - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Missing or invalid Authorization header',
    });
  }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    console.error('[VTID-01171] SUPABASE_JWT_SECRET not configured');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Authentication not configured',
    });
  }

  // Verify JWT and extract claims
  const payload = verifySupabaseJwt(token, jwtSecret);
  if (!payload) {
    console.warn('[VTID-01171] GET /api/v1/auth/me - Invalid JWT');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Invalid or expired token',
    });
  }

  // Extract identity from JWT claims
  const identity = {
    user_id: payload.sub || null,
    email: payload.email || '',
    tenant_id: payload.app_metadata?.active_tenant_id || null,
    exafy_admin: payload.app_metadata?.exafy_admin === true ||
                 payload.app_metadata?.is_exafy_admin === true ||
                 payload.user_metadata?.exafy_admin === true ||
                 false,
  };

  console.log('[VTID-01171] GET /api/v1/auth/me - JWT verified for user:', identity.user_id);

  // Try to fetch profile and memberships via RLS (optional enrichment)
  let profile: { display_name?: string; avatar_url?: string } | undefined;
  let memberships: Array<{ tenant_id: string; role: string; status: string }> | undefined;

  try {
    const supabase = createUserSupabaseClient(token);

    // Fetch profile (optional - don't fail if not available)
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('display_name, avatar_url')
      .eq('id', identity.user_id)
      .maybeSingle();

    if (!profileError && profileData) {
      profile = {
        display_name: profileData.display_name || undefined,
        avatar_url: profileData.avatar_url || undefined,
      };
    } else if (profileError) {
      console.log('[VTID-01171] Profile fetch skipped:', profileError.message);
    }

    // Fetch memberships (optional - don't fail if not available)
    const { data: membershipData, error: membershipError } = await supabase
      .from('memberships')
      .select('tenant_id, role, status')
      .eq('user_id', identity.user_id);

    if (!membershipError && membershipData && membershipData.length > 0) {
      memberships = membershipData.map((m: any) => ({
        tenant_id: m.tenant_id,
        role: m.role,
        status: m.status || 'active',
      }));
    } else if (membershipError) {
      console.log('[VTID-01171] Memberships fetch skipped:', membershipError.message);
    }
  } catch (err: any) {
    // Non-fatal: profile/memberships are optional enrichment
    console.log('[VTID-01171] Profile/memberships enrichment skipped:', err.message);
  }

  // Build response
  const response: {
    ok: boolean;
    identity: typeof identity;
    profile?: typeof profile;
    memberships?: typeof memberships;
  } = {
    ok: true,
    identity,
  };

  if (profile) {
    response.profile = profile;
  }

  if (memberships) {
    response.memberships = memberships;
  }

  console.log('[VTID-01171] GET /api/v1/auth/me - Success');
  return res.status(200).json(response);
});

export default router;
