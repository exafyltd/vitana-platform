/**
 * VTID-01047: Dev Token Mint Endpoint (Cloud-Shell Friendly)
 * VTID-01050: Dev Auth Bootstrap (break the NULL-role deadlock)
 *
 * Purpose: Enable fully automated Cloud Shell testing by minting a short-lived JWT
 * for a Supabase user without copying tokens from the browser.
 *
 * SECURITY: This endpoint is ONLY available in dev-sandbox environment.
 * It requires a secret header X-DEV-SECRET to be present.
 */

import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';

const router = Router();

// Valid roles for the role parameter
// VTID-01074: Added 'infra' role for platform infrastructure
const VALID_ROLES = ['patient', 'community', 'professional', 'staff', 'admin', 'developer', 'infra'] as const;

// VTID-01074: Valid tenant slugs and their corresponding UUIDs
const SLUG_TO_TENANT_ID: Record<string, string> = {
  'vitana': '00000000-0000-0000-0000-000000000001',
  'maxina': '00000000-0000-0000-0000-000000000002',
  'alkalma': '00000000-0000-0000-0000-000000000003',
  'earthlings': '00000000-0000-0000-0000-000000000004',
};
type ValidRole = typeof VALID_ROLES[number];

/**
 * Check if running in dev-sandbox environment.
 * Returns true if ENVIRONMENT or VITANA_ENV is set to "dev-sandbox".
 */
function isDevSandbox(): boolean {
  const env = process.env.ENVIRONMENT || process.env.VITANA_ENV;
  return env === 'dev-sandbox';
}

/**
 * Validate the X-DEV-SECRET header against DEV_AUTH_SECRET env var.
 * @returns null if valid, error object if invalid
 */
function validateDevSecret(req: Request): { code: string; status: number } | null {
  const headerSecret = req.headers['x-dev-secret'];
  const envSecret = process.env.DEV_AUTH_SECRET;

  if (!headerSecret) {
    return { code: 'MISSING_DEV_SECRET', status: 401 };
  }

  if (!envSecret) {
    console.error('[VTID-01047] DEV_AUTH_SECRET not configured in environment');
    return { code: 'INTERNAL_ERROR', status: 500 };
  }

  if (headerSecret !== envSecret) {
    return { code: 'INVALID_DEV_SECRET', status: 403 };
  }

  return null; // Valid
}

/**
 * Validate request body schema.
 * @returns null if valid, error message if invalid
 */
function validateBody(body: any): { error: string } | { email: string; role: ValidRole; tenant_id?: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }

  const { email, role, tenant_id } = body;

  if (!email || typeof email !== 'string' || email.trim() === '') {
    return { error: 'email is required and must be a non-empty string' };
  }

  if (!role || typeof role !== 'string') {
    return { error: 'role is required and must be a string' };
  }

  if (!VALID_ROLES.includes(role as ValidRole)) {
    return { error: `role must be one of: ${VALID_ROLES.join(', ')}` };
  }

  if (tenant_id !== undefined && typeof tenant_id !== 'string') {
    return { error: 'tenant_id must be a string (UUID) if provided' };
  }

  return { email: email.trim(), role: role as ValidRole, tenant_id };
}

/**
 * VTID-01050: Bootstrap request context for dev auth.
 * Calls the dev_bootstrap_request_context RPC using service_role to bypass
 * the is_platform_admin() deadlock where current_active_role() is NULL.
 *
 * @param supabase - Service role Supabase client
 * @param tenantId - The tenant ID to set in request context
 * @param activeRole - The active role to set (must be developer, admin, or staff)
 * @returns Result object with ok status
 */
async function bootstrapRequestContext(
  supabase: SupabaseClient,
  tenantId: string,
  activeRole: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('dev_bootstrap_request_context', {
      p_tenant_id: tenantId,
      p_active_role: activeRole,
    });

    if (error) {
      console.error('[VTID-01050] Bootstrap RPC error:', error.message);
      return { ok: false, error: error.message };
    }

    // Handle RPC-level errors (function returns {ok: false, error: ...})
    if (data && typeof data === 'object' && data.ok === false) {
      console.error('[VTID-01050] Bootstrap failed:', data.error);
      return { ok: false, error: data.error };
    }

    console.log('[VTID-01050] Request context bootstrapped:', data);
    return { ok: true };
  } catch (err: any) {
    console.error('[VTID-01050] Bootstrap exception:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * VTID-01050: Look up user by email and generate a session token using admin API.
 * Uses magic link generation + verification to mint a token without knowing the password.
 *
 * @param supabase - Service role Supabase client
 * @param email - The user's email
 * @returns The session data or error
 */
async function mintTokenForUser(
  supabase: SupabaseClient,
  email: string
): Promise<{ ok: true; token: string; user_id: string } | { ok: false; error: string; status: number }> {
  // Step 1: Look up user by email to verify they exist
  // Use GoTrue admin API directly as supabase-js doesn't have getUserByEmail
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[VTID-01050] Missing Supabase configuration');
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  const userLookupResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'apikey': supabaseServiceKey,
    },
  });

  if (!userLookupResponse.ok) {
    const errorText = await userLookupResponse.text();
    console.error('[VTID-01050] Error looking up user:', errorText);
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  const usersResult = await userLookupResponse.json() as { users?: any[] } | any[];
  const users = Array.isArray(usersResult) ? usersResult : (usersResult.users || []);

  if (!Array.isArray(users) || users.length === 0) {
    console.warn('[VTID-01050] User not found:', email);
    return { ok: false, error: 'USER_NOT_FOUND', status: 404 };
  }

  const user = users.find((u: any) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) {
    console.warn('[VTID-01050] User not found (email mismatch):', email);
    return { ok: false, error: 'USER_NOT_FOUND', status: 404 };
  }

  const userId = user.id;
  console.log('[VTID-01050] Found user:', userId);

  // Step 2: Generate a magic link for the user
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: email,
    options: {
      redirectTo: 'http://localhost:3000/auth/callback', // Dummy redirect, won't be used
    },
  });

  if (linkError) {
    console.error('[VTID-01050] Error generating magic link:', linkError.message);
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  if (!linkData?.properties?.hashed_token) {
    console.error('[VTID-01050] No hashed_token in link response');
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  // Step 3: Verify the OTP to get a session
  // When using token_hash, only token_hash and type should be provided (no email)
  const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });

  if (verifyError) {
    console.error('[VTID-01050] Error verifying OTP:', verifyError.message);
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  if (!verifyData?.session?.access_token) {
    console.error('[VTID-01050] No access_token in verify response');
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  console.log('[VTID-01050] Token minted successfully for user:', userId);
  return {
    ok: true,
    token: verifyData.session.access_token,
    user_id: userId,
  };
}

/**
 * Emit OASIS event for token issuance (minimal implementation).
 * Uses direct fetch to OASIS events table.
 */
async function emitTokenIssuedEvent(email: string, role: string, expiresIn: number): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[VTID-01047] Cannot emit OASIS event: missing Supabase credentials');
    return;
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const payload = {
    id: eventId,
    created_at: timestamp,
    vtid: 'VTID-01047',
    topic: 'dev.auth.token_issued',
    service: 'gateway-dev-auth',
    role: 'DEV',
    model: 'dev-token-mint',
    status: 'success',
    message: `Dev token issued for ${email} with role ${role}`,
    link: null,
    metadata: {
      email,
      role,
      expires_in: expiresIn,
      issued_at: timestamp,
    },
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[VTID-01047] Failed to emit OASIS event: ${response.status} - ${errorText}`);
    } else {
      console.log(`[VTID-01047] OASIS event emitted: dev.auth.token_issued (${eventId})`);
    }
  } catch (error) {
    console.warn('[VTID-01047] Error emitting OASIS event:', error);
  }
}

/**
 * POST /token
 *
 * VTID-01047 + VTID-01050: Mints a Bearer token for a specific user.
 * Uses admin API to look up user and generate a session token.
 * Bootstraps request context to break the NULL-role deadlock.
 *
 * Headers required:
 * - X-DEV-SECRET: <value matching DEV_AUTH_SECRET env var>
 *
 * Body:
 * {
 *   "email": "user@example.com",  // The user's actual email
 *   "role": "patient|community|professional|staff|admin|developer",
 *   "tenant_id": "uuid (optional)"
 * }
 *
 * Response (success):
 * {
 *   "ok": true,
 *   "token": "<JWT>",
 *   "expires_in": 900,
 *   "email": "user@example.com",
 *   "role": "developer"
 * }
 */
router.post('/token', async (req: Request, res: Response) => {
  // Gate 1: Check if running in dev-sandbox
  if (!isDevSandbox()) {
    console.warn('[VTID-01050] POST /dev/auth/token - Rejected: not in dev-sandbox environment');
    return res.status(403).json({
      ok: false,
      error: 'DEV_AUTH_DISABLED',
      message: 'This endpoint is only available in dev-sandbox environment',
    });
  }

  // Gate 2: Validate X-DEV-SECRET header
  const secretError = validateDevSecret(req);
  if (secretError) {
    console.warn(`[VTID-01050] POST /dev/auth/token - Rejected: ${secretError.code}`);
    return res.status(secretError.status).json({
      ok: false,
      error: secretError.code,
    });
  }

  // Gate 3: Validate request body
  const bodyValidation = validateBody(req.body);
  if ('error' in bodyValidation) {
    console.warn(`[VTID-01050] POST /dev/auth/token - Invalid body: ${bodyValidation.error}`);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: bodyValidation.error,
    });
  }

  const { email, role, tenant_id } = bodyValidation;

  // Gate 4: Get service role Supabase client
  const supabase = getSupabase();
  if (!supabase) {
    console.error('[VTID-01050] Service role Supabase client not available');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration missing',
    });
  }

  try {
    // VTID-01050: Bootstrap request context to break the NULL-role deadlock
    // This allows subsequent RPC calls to work even when current_active_role() is NULL
    // We use a deterministic tenant_id: from request, env, or generate one for dev
    const defaultTenantId = process.env.DEV_TENANT_ID || '00000000-0000-0000-0000-000000000001';
    const tenantId = tenant_id || defaultTenantId;

    // Only bootstrap for platform roles (developer, admin, staff)
    const bootstrapRoles = ['developer', 'admin', 'staff'];
    if (bootstrapRoles.includes(role)) {
      const bootstrapResult = await bootstrapRequestContext(supabase, tenantId, role);
      if (!bootstrapResult.ok) {
        console.warn(`[VTID-01050] Bootstrap failed (non-fatal): ${bootstrapResult.error}`);
        // Continue anyway - the RPC might not be deployed yet
      }
    }

    // VTID-01050: Mint token for the actual user (not a generic dev test user)
    const mintResult = await mintTokenForUser(supabase, email);

    if (!mintResult.ok) {
      console.error(`[VTID-01050] Token mint failed: ${mintResult.error}`);

      // Return appropriate HTTP status based on error type
      if (mintResult.error === 'USER_NOT_FOUND') {
        return res.status(404).json({
          ok: false,
          error: 'USER_NOT_FOUND',
          message: `User with email ${email} not found`,
        });
      }

      if (mintResult.error === 'FORBIDDEN') {
        return res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
          message: 'Permission denied',
        });
      }

      return res.status(mintResult.status).json({
        ok: false,
        error: mintResult.error,
        message: 'Failed to mint token',
      });
    }

    const token = mintResult.token;
    const expiresIn = 3600; // 1 hour (Supabase default for session tokens)

    // Emit OASIS event (async, non-blocking)
    emitTokenIssuedEvent(email, role, expiresIn).catch((err) => {
      console.warn('[VTID-01050] OASIS event emission failed:', err);
    });

    console.log(`[VTID-01050] Token issued for email="${email}" role="${role}" user_id="${mintResult.user_id}" (token: ${token.substring(0, 15)}...)`);

    return res.status(200).json({
      ok: true,
      token,
      expires_in: expiresIn,
      email,
      role,
      user_id: mintResult.user_id,
    });
  } catch (err: any) {
    console.error('[VTID-01050] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  }
});

/**
 * VTID-01074: POST /request-context
 *
 * Dev-only endpoint to override request context for testing.
 * Bootstraps tenant/role context via RPC and returns a dev token.
 *
 * Headers required:
 * - X-DEV-SECRET: <value matching DEV_AUTH_SECRET env var>
 *
 * Body:
 * {
 *   "tenant_slug": "vitana|maxina|alkalma|earthlings",
 *   "active_role": "developer|admin|staff|infra"
 * }
 *
 * Response (success):
 * {
 *   "ok": true,
 *   "tenant_id": "uuid",
 *   "tenant_slug": "vitana",
 *   "active_role": "developer",
 *   "message": "Context bootstrapped successfully"
 * }
 */
router.post('/request-context', async (req: Request, res: Response) => {
  // Gate 1: Check if running in dev-sandbox
  if (!isDevSandbox()) {
    console.warn('[VTID-01074] POST /dev/auth/request-context - Rejected: not in dev-sandbox environment');
    return res.status(403).json({
      ok: false,
      error: 'DEV_AUTH_DISABLED',
      message: 'This endpoint is only available in dev-sandbox environment',
    });
  }

  // Gate 2: Validate X-DEV-SECRET header
  const secretError = validateDevSecret(req);
  if (secretError) {
    console.warn(`[VTID-01074] POST /dev/auth/request-context - Rejected: ${secretError.code}`);
    return res.status(secretError.status).json({
      ok: false,
      error: secretError.code,
    });
  }

  // Gate 3: Validate request body
  const { tenant_slug, active_role } = req.body;

  if (!tenant_slug || typeof tenant_slug !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'tenant_slug is required and must be a string (vitana|maxina|alkalma|earthlings)',
    });
  }

  const tenantId = SLUG_TO_TENANT_ID[tenant_slug.toLowerCase()];
  if (!tenantId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_TENANT_SLUG',
      message: `tenant_slug must be one of: ${Object.keys(SLUG_TO_TENANT_ID).join(', ')}`,
    });
  }

  if (!active_role || typeof active_role !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'active_role is required and must be a string',
    });
  }

  if (!VALID_ROLES.includes(active_role as ValidRole)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_ROLE',
      message: `active_role must be one of: ${VALID_ROLES.join(', ')}`,
    });
  }

  // Gate 4: Get service role Supabase client
  const supabase = getSupabase();
  if (!supabase) {
    console.error('[VTID-01074] Service role Supabase client not available');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration missing',
    });
  }

  try {
    // Bootstrap request context via RPC
    const bootstrapResult = await bootstrapRequestContext(supabase, tenantId, active_role);

    if (!bootstrapResult.ok) {
      console.error(`[VTID-01074] Bootstrap failed: ${bootstrapResult.error}`);
      return res.status(500).json({
        ok: false,
        error: 'BOOTSTRAP_FAILED',
        message: bootstrapResult.error,
      });
    }

    console.log(`[VTID-01074] Request context bootstrapped: tenant_slug="${tenant_slug}" (${tenantId}), active_role="${active_role}"`);

    return res.status(200).json({
      ok: true,
      tenant_id: tenantId,
      tenant_slug: tenant_slug.toLowerCase(),
      active_role,
      message: 'Context bootstrapped successfully',
    });
  } catch (err: any) {
    console.error('[VTID-01074] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  }
});

export default router;
