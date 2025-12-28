/**
 * VTID-01047: Dev Token Mint Endpoint (Cloud-Shell Friendly)
 *
 * Purpose: Enable fully automated Cloud Shell testing by minting a short-lived JWT
 * for a Supabase user without copying tokens from the browser.
 *
 * SECURITY: This endpoint is ONLY available in dev-sandbox environment.
 * It requires a secret header X-DEV-SECRET to be present.
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const router = Router();

// Valid roles for the role parameter
const VALID_ROLES = ['patient', 'community', 'professional', 'staff', 'admin', 'developer'] as const;
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
 * Mints a 15-minute Bearer token for the dedicated dev test user.
 * The email in the request body is used for logging only.
 *
 * Headers required:
 * - X-DEV-SECRET: <value matching DEV_AUTH_SECRET env var>
 *
 * Body:
 * {
 *   "email": "user@example.com",  // Label for logging
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
    console.warn('[VTID-01047] POST /dev/auth/token - Rejected: not in dev-sandbox environment');
    return res.status(403).json({
      ok: false,
      error: 'DEV_AUTH_DISABLED',
      message: 'This endpoint is only available in dev-sandbox environment',
    });
  }

  // Gate 2: Validate X-DEV-SECRET header
  const secretError = validateDevSecret(req);
  if (secretError) {
    console.warn(`[VTID-01047] POST /dev/auth/token - Rejected: ${secretError.code}`);
    return res.status(secretError.status).json({
      ok: false,
      error: secretError.code,
    });
  }

  // Gate 3: Validate request body
  const bodyValidation = validateBody(req.body);
  if ('error' in bodyValidation) {
    console.warn(`[VTID-01047] POST /dev/auth/token - Invalid body: ${bodyValidation.error}`);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: bodyValidation.error,
    });
  }

  const { email, role } = bodyValidation;

  // Get dev test user credentials from environment
  const devEmail = process.env.DEV_TEST_USER_EMAIL;
  const devPassword = process.env.DEV_TEST_USER_PASSWORD;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!devEmail || !devPassword) {
    console.error('[VTID-01047] DEV_TEST_USER_EMAIL or DEV_TEST_USER_PASSWORD not configured');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Dev test user credentials not configured',
    });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[VTID-01047] SUPABASE_URL or SUPABASE_ANON_KEY not configured');
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration missing',
    });
  }

  try {
    // Create Supabase client with anon key for auth
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Sign in with the dev test user credentials
    const { data, error } = await supabase.auth.signInWithPassword({
      email: devEmail,
      password: devPassword,
    });

    if (error) {
      console.error('[VTID-01047] Supabase auth error:', error.message);

      // Check for specific error types
      if (error.message.includes('Invalid login credentials')) {
        return res.status(404).json({
          ok: false,
          error: 'USER_NOT_FOUND',
          message: 'Dev test user not found or invalid credentials',
        });
      }

      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Authentication failed',
      });
    }

    if (!data.session?.access_token) {
      console.error('[VTID-01047] No access token in session response');
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to obtain access token',
      });
    }

    const token = data.session.access_token;
    const expiresIn = 900; // 15 minutes (Supabase default, but we document it as 15 min)

    // Emit OASIS event (async, non-blocking)
    emitTokenIssuedEvent(email, role, expiresIn).catch((err) => {
      console.warn('[VTID-01047] OASIS event emission failed:', err);
    });

    console.log(`[VTID-01047] Token issued for label="${email}" role="${role}" (token: ${token.substring(0, 15)}...)`);

    return res.status(200).json({
      ok: true,
      token,
      expires_in: expiresIn,
      email,
      role,
    });
  } catch (err: any) {
    console.error('[VTID-01047] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  }
});

export default router;
