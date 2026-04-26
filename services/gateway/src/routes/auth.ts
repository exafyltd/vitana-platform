/**
 * VTID-01157: Auth Routes (Dev Onboarding MVP)
 * VTID-01186: Dev Auth Handshake + Identity Propagation
 *
 * Purpose: Provide authentication endpoints for the Gateway.
 * - GET /config - Returns Supabase config for frontend auth (no auth required)
 * - POST /login - Email/password login via Supabase (no auth required)
 * - GET /me - Returns the authenticated user's identity
 * - PUT /profile - Update the authenticated user's profile (VTID-01867)
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
import { notifyUserAsync } from '../services/notification-service';
import { generatePersonalRecommendations } from '../services/recommendation-engine';
import { sendWelcomeChatMessages } from '../services/welcome-chat-service';

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

    // Fire welcome notification once (first login)
    if (supabase && authData.user?.id) {
      const uid = authData.user.id;
      // Resolve tenant_id from memberships
      const { data: tenantRow } = await supabase
        .from('user_tenants')
        .select('tenant_id')
        .eq('user_id', uid)
        .eq('is_primary', true)
        .single();
      const tid = tenantRow?.tenant_id;
      if (tid) {
        // Only send welcome if user has never received it
        const { count } = await supabase
          .from('user_notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', uid)
          .eq('type', 'welcome_to_vitana');
        if (count === 0) {
          notifyUserAsync(uid, tid, 'welcome_to_vitana', {
            title: 'Welcome to Vitana!',
            body: 'Your journey to a healthier, more connected life starts now.',
            data: { url: '/dashboard' },
          }, supabase);

          // Also prompt to complete profile
          notifyUserAsync(uid, tid, 'complete_your_profile', {
            title: 'Complete Your Profile',
            body: 'Add your name, photo, and interests to get personalized matches.',
            data: { url: '/profile/edit' },
          }, supabase);

          // Generate starter autopilot recommendations (fire-and-forget)
          generatePersonalRecommendations(uid, tid, { trigger_type: 'first_login' })
            .then(result => {
              console.log(
                `[VTID-01185] First-login recommendations for ${uid.slice(0, 8)}: ` +
                `generated=${result.generated}, duplicates=${result.duplicates_skipped}`
              );
            })
            .catch(err => {
              console.warn(`[VTID-01185] First-login recommendations failed for ${uid.slice(0, 8)}: ${err.message}`);
            });

          // Send welcome chat messages from new user to all community members (fire-and-forget)
          sendWelcomeChatMessages(uid, tid, profile.display_name, supabase as any)
            .then(result => {
              console.log(
                `[WelcomeChat] First-login for ${uid.slice(0, 8)}: ` +
                `sent=${result.sent}, skipped=${result.skipped}${result.reason ? `, reason=${result.reason}` : ''}`
              );
            })
            .catch(err => {
              console.warn(`[WelcomeChat] First-login failed for ${uid.slice(0, 8)}: ${err.message}`);
            });
        }
      }
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
 * BOOTSTRAP-DEV-6H-SESSION: POST /refresh
 *
 * Exchange a Supabase refresh_token for a fresh access_token + refresh_token.
 * Proxies to Supabase GoTrue `/token?grant_type=refresh_token`. Does NOT
 * require an Authorization header — the refresh token IS the credential.
 *
 * Body:
 *   { "refresh_token": "..." }
 *
 * Success (200):
 *   { "ok": true, "access_token", "refresh_token", "expires_in", "token_type" }
 *
 * Failure (401):
 *   { "ok": false, "error": "INVALID_REFRESH_TOKEN", "message": "..." }
 */
router.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token || typeof refresh_token !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'refresh_token is required',
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[BOOTSTRAP-DEV-6H-SESSION] POST /auth/refresh - Missing Supabase config');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration not available',
    });
  }

  try {
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token }),
    });

    const authData = await authResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      error?: string;
      error_description?: string;
      msg?: string;
    };

    if (!authResponse.ok || !authData.access_token) {
      console.warn(
        `[BOOTSTRAP-DEV-6H-SESSION] POST /auth/refresh - failed: ${authData.error || authData.msg || authResponse.status}`
      );
      return res.status(401).json({
        ok: false,
        error: 'INVALID_REFRESH_TOKEN',
        message: authData.error_description || authData.msg || 'Refresh token is invalid or expired',
      });
    }

    return res.status(200).json({
      ok: true,
      access_token: authData.access_token,
      refresh_token: authData.refresh_token,
      expires_in: authData.expires_in,
      token_type: authData.token_type || 'bearer',
    });
  } catch (err: any) {
    console.error('[BOOTSTRAP-DEV-6H-SESSION] POST /auth/refresh - Exception:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Token refresh service error',
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
  // VTID-01967: also expose vitana_id (from app_users mirror) and vitana_id_locked (from profiles).
  let profile: {
    display_name?: string;
    avatar_url?: string;
    bio?: string;
    vitana_id?: string;
    vitana_id_locked?: boolean;
  } = {};
  let memberships: Array<{ tenant_id: string; role: string; is_primary: boolean }> = [];

  const supabase = getSupabase();
  if (supabase && identity.user_id) {
    try {
      // Fetch user profile from app_users — vitana_id is mirrored here by the
      // Release A trigger profiles_vitana_id_mirror_trigger.
      const { data: profileData, error: profileError } = await supabase
        .from('app_users')
        .select('display_name, avatar_url, bio, vitana_id')
        .eq('user_id', identity.user_id)
        .single();

      if (!profileError && profileData) {
        profile = {
          display_name: profileData.display_name || undefined,
          avatar_url: profileData.avatar_url || undefined,
          bio: profileData.bio || undefined,
          vitana_id: (profileData as any).vitana_id || undefined,
        };
      }

      // VTID-01967: vitana_id_locked lives only on profiles (not mirrored).
      // Parallel fetch — null-tolerant (column may not exist before Release A).
      try {
        const { data: lockData } = await supabase
          .from('profiles')
          .select('vitana_id_locked, vitana_id')
          .eq('user_id', identity.user_id)
          .maybeSingle();
        if (lockData) {
          profile.vitana_id_locked = (lockData as any).vitana_id_locked === true;
          // Profiles is the source of truth; if app_users mirror is stale (or
          // not yet provisioned), prefer profiles.vitana_id.
          if (!profile.vitana_id && (lockData as any).vitana_id) {
            profile.vitana_id = (lockData as any).vitana_id;
          }
        }
      } catch (_lockErr) {
        // Silent — profiles.vitana_id_locked may not exist on this env yet.
      }

      // VTID-01230-FIX: Match /auth/login fallback chain for avatar_url.
      // If app_users has no avatar_url, try users table (vitana-v1 compat),
      // then auth.users.user_metadata. Otherwise fetchAuthMe() in the frontend
      // overwrites state.user with avatar_url=null, making the avatar disappear
      // moments after login.
      if (!profile.avatar_url) {
        try {
          const { data: usersData } = await supabase
            .from('users')
            .select('display_name, avatar_url')
            .eq('id', identity.user_id)
            .single();
          if (usersData) {
            if (!profile.display_name && usersData.display_name) {
              profile.display_name = usersData.display_name;
            }
            if (usersData.avatar_url) {
              profile.avatar_url = usersData.avatar_url;
              console.log(`[VTID-01230-FIX] /auth/me avatar_url from users table: ${profile.avatar_url}`);
            }
          }
        } catch (_usersErr) {
          // Silent — users table may not exist in all envs
        }
      }

      if (!profile.avatar_url) {
        // Try auth.users.user_metadata
        try {
          const { data: authUser } = await (supabase as any).auth.admin.getUserById(identity.user_id);
          const metaAvatar = authUser?.user?.user_metadata?.avatar_url;
          if (metaAvatar) {
            profile.avatar_url = metaAvatar;
            console.log(`[VTID-01230-FIX] /auth/me avatar_url from user_metadata: ${metaAvatar}`);
          }
        } catch (_metaErr) {
          // Silent — admin API requires service role
        }
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

      // ---------------------------------------------------------------
      // AUTO-PROVISION SAFETY NET
      // If the user exists in auth.users but has no app_users row or no
      // user_tenants membership (trigger failed, race condition, etc.),
      // provision them on the spot so they're never permanently broken.
      // ---------------------------------------------------------------
      const missingProfile = !!profileError || !profileData;
      const missingMembership = !membershipData || membershipData.length === 0;

      if (missingProfile || missingMembership) {
        console.warn(
          `[AUTO-PROVISION] User ${identity.user_id} (${identity.email}) missing records: ` +
          `app_users=${missingProfile ? 'MISSING' : 'ok'}, user_tenants=${missingMembership ? 'MISSING' : 'ok'}`
        );

        // Resolve default tenant (oldest)
        const { data: tenantRow } = await supabase
          .from('tenants')
          .select('id')
          .order('created_at', { ascending: true })
          .limit(1)
          .single();

        const defaultTenantId = tenantRow?.id as string | undefined;

        if (missingProfile) {
          const displayName = identity.email
            ? identity.email.split('@')[0]
            : 'User';

          const { data: newProfile, error: provErr } = await supabase
            .from('app_users')
            .upsert(
              {
                user_id: identity.user_id,
                email: identity.email,
                display_name: displayName,
                tenant_id: defaultTenantId || null,
              },
              { onConflict: 'user_id' }
            )
            .select('display_name, avatar_url, bio')
            .single();

          if (!provErr && newProfile) {
            profile = {
              display_name: newProfile.display_name || undefined,
              avatar_url: newProfile.avatar_url || undefined,
              bio: newProfile.bio || undefined,
            };
            console.log(`[AUTO-PROVISION] Created app_users row for ${identity.user_id}`);
          } else if (provErr) {
            console.error(`[AUTO-PROVISION] Failed to create app_users: ${provErr.message}`);
          }
        }

        if (missingMembership && defaultTenantId) {
          const { data: newMembership, error: memErr } = await supabase
            .from('user_tenants')
            .upsert(
              {
                tenant_id: defaultTenantId,
                user_id: identity.user_id,
                active_role: 'community',
                is_primary: true,
              },
              { onConflict: 'tenant_id,user_id' }
            )
            .select('tenant_id, active_role, is_primary')
            .single();

          if (!memErr && newMembership) {
            memberships = [
              {
                tenant_id: newMembership.tenant_id,
                role: newMembership.active_role || 'community',
                is_primary: newMembership.is_primary || false,
              },
            ];
            console.log(`[AUTO-PROVISION] Created user_tenants row for ${identity.user_id} in tenant ${defaultTenantId}`);
          } else if (memErr) {
            console.error(`[AUTO-PROVISION] Failed to create user_tenants: ${memErr.message}`);
          }
        }
      }

      console.log(`[VTID-01186] Profile loaded: display_name=${profile.display_name}, memberships=${memberships.length}`);
    } catch (err: any) {
      console.warn(`[VTID-01186] Failed to load profile/memberships: ${err.message}`);
      // Continue with empty profile/memberships - don't fail the request
    }
  }

  // Prevent browser from caching profile data
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

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
 * VTID-01867: PUT /profile
 *
 * Update the authenticated user's profile (display_name, bio).
 * Persists to the app_users table.
 *
 * Request body:
 * {
 *   "display_name"?: string,
 *   "bio"?: string
 * }
 *
 * Response (success - 200):
 * {
 *   "ok": true,
 *   "profile": { "display_name": "...", "avatar_url": "...", "bio": "..." }
 * }
 */
router.put('/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity!;
  const { display_name, bio } = req.body || {};

  console.log(
    `[VTID-01867] PUT /auth/profile - user_id=${identity.user_id} display_name=${display_name}`
  );

  // Validate: at least one field must be provided
  if (display_name === undefined && bio === undefined) {
    return res.status(400).json({ ok: false, error: 'No fields to update. Provide display_name or bio.' });
  }

  // Validate display_name if provided
  if (display_name !== undefined) {
    if (typeof display_name !== 'string' || display_name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'display_name must be a non-empty string.' });
    }
    if (display_name.trim().length > 100) {
      return res.status(400).json({ ok: false, error: 'display_name must be 100 characters or less.' });
    }
  }

  // Validate bio if provided
  if (bio !== undefined && typeof bio !== 'string') {
    return res.status(400).json({ ok: false, error: 'bio must be a string.' });
  }
  if (bio !== undefined && bio.length > 500) {
    return res.status(400).json({ ok: false, error: 'bio must be 500 characters or less.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Database not available.' });
  }

  try {
    const trimmedName = display_name !== undefined ? display_name.trim() : undefined;
    const trimmedBio = bio !== undefined ? bio.trim() : undefined;

    const updates: Record<string, unknown> = {};
    if (trimmedName !== undefined) updates.display_name = trimmedName;
    if (trimmedBio !== undefined) updates.bio = trimmedBio;
    updates.updated_at = new Date().toISOString();

    // Try UPDATE first (the row should exist from GET /me auto-provision)
    const { data, error } = await supabase
      .from('app_users')
      .update(updates)
      .eq('user_id', identity.user_id)
      .select('display_name, avatar_url, bio');

    if (error) {
      console.error(`[VTID-01867] Profile update failed: ${error.message} (code=${error.code})`);
      return res.status(500).json({ ok: false, error: 'Failed to update profile.' });
    }

    // If no row was found, create one first, then return the profile
    if (!data || data.length === 0) {
      console.warn(`[VTID-01867] No app_users row for ${identity.user_id}, creating one`);
      const insertPayload: Record<string, unknown> = {
        user_id: identity.user_id,
        email: identity.email || 'unknown@example.com',
        ...updates,
      };
      const { data: insertedData, error: insertError } = await supabase
        .from('app_users')
        .insert(insertPayload)
        .select('display_name, avatar_url, bio')
        .single();

      if (insertError) {
        console.error(`[VTID-01867] Profile insert failed: ${insertError.message}`);
        return res.status(500).json({ ok: false, error: 'Failed to create profile.' });
      }

      console.log(`[VTID-01867] Profile created for ${identity.user_id}`);
      return res.status(200).json({
        ok: true,
        profile: {
          display_name: insertedData.display_name || undefined,
          avatar_url: insertedData.avatar_url || undefined,
          bio: insertedData.bio || undefined,
        },
      });
    }

    console.log(`[VTID-01867] Profile updated for ${identity.user_id}`);

    // Fire-and-forget milestone check for profile update
    if (identity.user_id && identity.tenant_id) {
      import('../services/milestone-service').then(({ checkMilestonesForAction }) => {
        checkMilestonesForAction(supabase, identity.user_id, identity.tenant_id!, 'profile_updated').catch(() => {});
      }).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      profile: {
        display_name: data[0].display_name || undefined,
        avatar_url: data[0].avatar_url || undefined,
        bio: data[0].bio || undefined,
      },
    });
  } catch (err: any) {
    console.error(`[VTID-01867] Profile update exception: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
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
