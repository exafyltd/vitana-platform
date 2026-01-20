/**
 * VTID-01157: Auth Routes (Dev Onboarding MVP)
 * VTID-01186: Dev Auth Handshake + Identity Propagation
 *
 * Purpose: Provide authentication endpoints for the Gateway.
 * - GET /config - Returns Supabase config for frontend auth (no auth required)
 * - POST /login - Email/password login via Supabase (no auth required)
 * - GET /me - Returns the authenticated user's identity
 *
 * This endpoint verifies the Supabase JWT and returns identity claims
 * extracted from the token.
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();

/**
 * VTID-01186: GET /config
 *
 * Returns Supabase configuration for frontend authentication.
 * This allows the frontend to initialize Supabase auth without hardcoding keys.
 * Does NOT require authentication.
 *
 * Response (success - 200):
 * {
 *   "ok": true,
 *   "supabase_url": "https://xxx.supabase.co",
 *   "supabase_anon_key": "eyJ..."
 * }
 */
router.get('/config', (_req: Request, res: Response) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[VTID-01186] GET /auth/config - Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration not available',
    });
  }

  console.log('[VTID-01186] GET /auth/config - Returning Supabase config');
  return res.status(200).json({
    ok: true,
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
  });
});

/**
 * VTID-01186: POST /login
 *
 * Email/password login via Supabase Auth REST API.
 * Proxies the request to Supabase and returns the session tokens.
 * Does NOT require authentication.
 *
 * Body:
 * {
 *   "email": "user@example.com",
 *   "password": "..."
 * }
 *
 * Response (success - 200):
 * {
 *   "ok": true,
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "expires_in": 3600,
 *   "token_type": "bearer",
 *   "user": { ... }
 * }
 *
 * Response (error - 401):
 * {
 *   "ok": false,
 *   "error": "INVALID_CREDENTIALS",
 *   "message": "..."
 * }
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || typeof email !== 'string' || email.trim() === '') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'email is required',
    });
  }

  if (!password || typeof password !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'password is required',
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[VTID-01186] POST /auth/login - Missing Supabase configuration');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration not available',
    });
  }

  try {
    // Call Supabase Auth REST API for email/password login
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({
        email: email.trim(),
        password,
      }),
    });

    const authData = await authResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      user?: {
        id?: string;
        email?: string;
        user_metadata?: {
          avatar_url?: string;
          full_name?: string;
          name?: string;
        };
      };
      error?: string;
      error_description?: string;
      msg?: string;
    };

    if (!authResponse.ok) {
      console.warn(`[VTID-01186] POST /auth/login - Auth failed for ${email}: ${authData.error || authData.msg || 'Unknown error'}`);
      return res.status(401).json({
        ok: false,
        error: 'INVALID_CREDENTIALS',
        message: authData.error_description || authData.msg || 'Invalid email or password',
      });
    }

    console.log(`[VTID-01186] POST /auth/login - Success for ${email}, user_id=${authData.user?.id}`);

    // VTID-01196: Fetch profile from app_users to get avatar_url
    let profile: { display_name?: string; avatar_url?: string; bio?: string } = {};
    const supabase = getSupabase();
    if (supabase && authData.user?.id) {
      try {
        // First try app_users table
        const { data: profileData, error: profileError } = await supabase
          .from('app_users')
          .select('display_name, avatar_url, bio')
          .eq('user_id', authData.user.id)
          .single();

        if (!profileError && profileData) {
          profile = {
            display_name: profileData.display_name || undefined,
            avatar_url: profileData.avatar_url || undefined,
            bio: profileData.bio || undefined,
          };
          console.log(`[VTID-01196] Profile from app_users: display_name=${profile.display_name}, avatar_url=${profile.avatar_url || 'null'}`);
        } else if (profileError) {
          console.log(`[VTID-01196] app_users query: ${profileError.message}`);
        }

        // If no avatar, try users table (vitana-v1 compatibility)
        if (!profile.avatar_url) {
          const { data: usersData, error: usersError } = await supabase
            .from('users')
            .select('display_name, avatar_url')
            .eq('id', authData.user.id)
            .single();

          if (!usersError && usersData) {
            if (!profile.display_name && usersData.display_name) {
              profile.display_name = usersData.display_name;
            }
            if (usersData.avatar_url) {
              profile.avatar_url = usersData.avatar_url;
              console.log(`[VTID-01196] Avatar from users table: ${profile.avatar_url}`);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[VTID-01196] Failed to load profile during login: ${err.message}`);
      }
    }

    // Also check user_metadata from Supabase auth for avatar
    const userMetaAvatar = authData.user?.user_metadata?.avatar_url;
    if (!profile.avatar_url && userMetaAvatar) {
      profile.avatar_url = userMetaAvatar;
      console.log(`[VTID-01196] Avatar from user_metadata: ${userMetaAvatar}`);
    }

    return res.status(200).json({
      ok: true,
      access_token: authData.access_token,
      refresh_token: authData.refresh_token,
      expires_in: authData.expires_in,
      token_type: authData.token_type || 'bearer',
      user: authData.user,
      profile, // VTID-01196: Include profile with avatar_url
    });
  } catch (err: any) {
    console.error('[VTID-01186] POST /auth/login - Exception:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Authentication service error',
    });
  }
});

/**
 * GET /me
 *
 * Returns the authenticated user's identity, profile, and memberships.
 * Requires a valid Supabase JWT in the Authorization header.
 *
 * VTID-01186: Enhanced to fetch profile data (display_name, avatar_url) from database.
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
 *   },
 *   "profile": {
 *     "display_name": "John Doe",
 *     "avatar_url": "https://...",
 *     "bio": "..."
 *   },
 *   "memberships": [
 *     { "tenant_id": "uuid", "role": "admin", "is_primary": true }
 *   ]
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
    `[VTID-01186] GET /auth/me - user_id=${identity.user_id} exafy_admin=${identity.exafy_admin}`
  );

  // VTID-01186: Fetch profile and memberships from database
  let profile: { display_name?: string; avatar_url?: string; bio?: string } = {};
  let memberships: Array<{ tenant_id: string; role: string; is_primary: boolean }> = [];

  const supabase = getSupabase();
  if (supabase && identity.user_id) {
    try {
      // Fetch user profile from app_users
      const { data: profileData, error: profileError } = await supabase
        .from('app_users')
        .select('display_name, avatar_url, bio')
        .eq('user_id', identity.user_id)
        .single();

      if (!profileError && profileData) {
        profile = {
          display_name: profileData.display_name || undefined,
          avatar_url: profileData.avatar_url || undefined,
          bio: profileData.bio || undefined,
        };
      }

      // Fetch user memberships from user_tenants
      const { data: membershipData, error: membershipError } = await supabase
        .from('user_tenants')
        .select('tenant_id, active_role, is_primary')
        .eq('user_id', identity.user_id);

      if (!membershipError && membershipData) {
        memberships = membershipData.map((m: any) => ({
          tenant_id: m.tenant_id,
          role: m.active_role || 'community',
          is_primary: m.is_primary || false,
        }));
      }

      console.log(`[VTID-01186] Profile loaded: display_name=${profile.display_name}, memberships=${memberships.length}`);
    } catch (err: any) {
      console.warn(`[VTID-01186] Failed to load profile/memberships: ${err.message}`);
      // Continue with empty profile/memberships - don't fail the request
    }
  }

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
    profile,
    memberships,
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
