/**
 * VTID-01157: Auth Routes (Dev Onboarding MVP)
 *
 * Purpose: Provide authentication endpoints for the Gateway.
 * - GET /me - Returns the authenticated user's identity
 *
 * This endpoint verifies the Supabase JWT and returns identity claims
 * extracted from the token.
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';

const router = Router();

/**
 * GET /me
 *
 * Returns the authenticated user's identity extracted from their JWT.
 * Requires a valid Supabase JWT in the Authorization header.
 *
 * Headers required:
 * - Authorization: Bearer <supabase_access_token>
 *
 * Response (success - 200):
 * {
 *   "ok": true,
 *   "identity": {
 *     "user_id": "uuid",
 *     "email": "user@example.com",
 *     "tenant_id": "uuid or null",
 *     "exafy_admin": true/false,
 *     "role": "authenticated",
 *     "exp": 1234567890,
 *     "iat": 1234567800
 *   }
 * }
 *
 * Response (error - 401):
 * {
 *   "ok": false,
 *   "error": "UNAUTHENTICATED",
 *   "message": "..."
 * }
 */
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // Identity is guaranteed to exist after requireAuth middleware
  const identity = req.identity!;

  console.log(
    `[VTID-01157] GET /auth/me - user_id=${identity.user_id} exafy_admin=${identity.exafy_admin}`
  );

  return res.status(200).json({
    ok: true,
    identity: {
      user_id: identity.user_id,
      email: identity.email,
      tenant_id: identity.tenant_id,
      exafy_admin: identity.exafy_admin,
      role: identity.role,
      aud: identity.aud,
      exp: identity.exp,
      iat: identity.iat,
    },
  });
});

/**
 * GET /me/debug
 *
 * Returns the full raw JWT claims for debugging purposes.
 * Only available when exafy_admin = true.
 *
 * Response (success - 200):
 * {
 *   "ok": true,
 *   "identity": { ... },
 *   "raw_claims": { ... full JWT payload ... }
 * }
 */
router.get('/me/debug', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity!;

  // Only allow exafy_admin to see raw claims
  if (!identity.exafy_admin) {
    return res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Debug endpoint requires exafy_admin privileges',
    });
  }

  console.log(
    `[VTID-01157] GET /auth/me/debug - user_id=${identity.user_id}`
  );

  return res.status(200).json({
    ok: true,
    identity,
    raw_claims: req.auth_raw_claims,
  });
});

/**
 * GET /health
 *
 * Health check for auth service. Returns configuration status.
 * Does NOT require authentication.
 */
router.get('/health', (_req, res: Response) => {
  const hasJwtSecret = !!process.env.SUPABASE_JWT_SECRET;
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;

  return res.status(200).json({
    ok: true,
    service: 'auth',
    vtid: 'VTID-01157',
    config: {
      jwt_secret_configured: hasJwtSecret,
      supabase_url_configured: hasSupabaseUrl,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
