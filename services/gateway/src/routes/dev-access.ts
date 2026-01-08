/**
 * VTID-01172: Dev Access Management Routes
 *
 * Purpose: Allow exafy_admin users to manage Dev Access (exafy_admin flag) for other users.
 * This is a DEV-only control surface for onboarding without Lovable Admin.
 *
 * Endpoints:
 * - GET  /users       - List dev-enabled users (exafy_admin=true), with optional email search
 * - POST /grant       - Grant dev access (set exafy_admin=true) to a user by email
 * - POST /revoke      - Revoke dev access (set exafy_admin=false) from a user by email
 *
 * Security:
 * - All endpoints require valid Bearer token (authenticated user)
 * - Caller must have exafy_admin=true in their app_metadata
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();
const VTID = 'VTID-01172';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header.
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Verify caller is an exafy_admin user.
 * Returns the caller's user_id if authorized, or an error response.
 */
async function verifyExafyAdmin(
  req: Request
): Promise<{ ok: true; user_id: string; email: string } | { ok: false; status: number; error: string }> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: 'UNAUTHENTICATED' };
  }

  // Get caller identity from their token
  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();

    if (authError || !authData?.user) {
      console.warn(`[${VTID}] Failed to get user from token:`, authError?.message);
      return { ok: false, status: 401, error: 'INVALID_TOKEN' };
    }

    const callerId = authData.user.id;
    const callerEmail = authData.user.email || 'unknown';

    // Check if caller has exafy_admin in app_metadata
    // Note: The user's app_metadata is returned from auth.getUser() call
    const appMetadata = authData.user.app_metadata || {};
    const isExafyAdmin = appMetadata.exafy_admin === true;

    if (!isExafyAdmin) {
      console.warn(`[${VTID}] Access denied: user ${callerEmail} (${callerId}) is not exafy_admin`);
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }

    console.log(`[${VTID}] Authorized: ${callerEmail} (${callerId}) is exafy_admin`);
    return { ok: true, user_id: callerId, email: callerEmail };
  } catch (err: any) {
    console.error(`[${VTID}] Auth error:`, err.message);
    return { ok: false, status: 500, error: 'INTERNAL_ERROR' };
  }
}

/**
 * Look up a user by email using Supabase Admin API.
 */
async function lookupUserByEmail(
  email: string
): Promise<{ ok: true; user: any } | { ok: false; error: string; status: number }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          apikey: supabaseServiceKey,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Error looking up user:`, errorText);
      return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
    }

    const result = (await response.json()) as { users?: any[] } | any[];
    const users = Array.isArray(result) ? result : result.users || [];

    // Find exact match (case-insensitive)
    const user = users.find((u: any) => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) {
      return { ok: false, error: 'USER_NOT_FOUND', status: 404 };
    }

    return { ok: true, user };
  } catch (err: any) {
    console.error(`[${VTID}] User lookup error:`, err.message);
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }
}

/**
 * List users with exafy_admin=true, optionally filtered by email substring.
 * Uses Supabase Admin API to list users and filter by app_metadata.
 */
async function listDevUsers(
  query?: string
): Promise<{ ok: true; users: any[] } | { ok: false; error: string; status: number }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }

  try {
    // Fetch users from Supabase Admin API (paginated - get up to 100 users)
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=100`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${supabaseServiceKey}`,
        apikey: supabaseServiceKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Error listing users:`, errorText);
      return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
    }

    const result = (await response.json()) as { users?: any[] } | any[];
    const allUsers = Array.isArray(result) ? result : result.users || [];

    // Filter to users with exafy_admin=true
    let devUsers = allUsers.filter((u: any) => u.app_metadata?.exafy_admin === true);

    // If query provided, filter by email substring (case-insensitive)
    if (query && query.trim()) {
      const q = query.toLowerCase().trim();
      devUsers = devUsers.filter((u: any) => u.email?.toLowerCase().includes(q));
    }

    // Map to safe output format
    const users = devUsers.map((u: any) => ({
      user_id: u.id,
      email: u.email,
      exafy_admin: true,
      updated_at: u.updated_at || u.created_at,
    }));

    return { ok: true, users };
  } catch (err: any) {
    console.error(`[${VTID}] List users error:`, err.message);
    return { ok: false, error: 'INTERNAL_ERROR', status: 500 };
  }
}

/**
 * Emit OASIS event for dev access grant/revoke.
 */
async function emitDevAccessEvent(
  action: 'grant' | 'revoke',
  targetEmail: string,
  actorEmail: string
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[${VTID}] Cannot emit OASIS event: missing Supabase credentials`);
    return;
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const payload = {
    id: eventId,
    created_at: timestamp,
    vtid: VTID,
    topic: `dev.access.${action}`,
    service: 'gateway-dev-access',
    role: 'DEV',
    model: 'dev-access-toggle',
    status: 'success',
    message: `Dev access ${action}ed for ${targetEmail} by ${actorEmail}`,
    link: null,
    metadata: {
      target_email: targetEmail,
      actor_email: actorEmail,
      action,
      issued_at: timestamp,
    },
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[${VTID}] Failed to emit OASIS event: ${response.status} - ${errorText}`);
    } else {
      console.log(`[${VTID}] OASIS event emitted: dev.access.${action} (${eventId})`);
    }
  } catch (error) {
    console.warn(`[${VTID}] Error emitting OASIS event:`, error);
  }
}

// =============================================================================
// Endpoints
// =============================================================================

/**
 * GET /users
 *
 * List dev-enabled users (exafy_admin=true), with optional email search.
 *
 * Query params:
 * - query: Optional email substring to filter by
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "users": [
 *     { "user_id": "uuid", "email": "user@example.com", "exafy_admin": true, "updated_at": "..." }
 *   ]
 * }
 */
router.get('/users', async (req: Request, res: Response) => {
  // Verify caller is exafy_admin
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({
      ok: false,
      error: authResult.error,
    });
  }

  const query = req.query.query as string | undefined;

  // List dev users
  const result = await listDevUsers(query);
  if (!result.ok) {
    return res.status(result.status).json({
      ok: false,
      error: result.error,
    });
  }

  console.log(`[${VTID}] GET /users - Listed ${result.users.length} dev users (query: ${query || 'none'})`);

  return res.status(200).json({
    ok: true,
    users: result.users,
  });
});

/**
 * POST /grant
 *
 * Grant dev access (set exafy_admin=true) to a user by email.
 *
 * Body:
 * {
 *   "email": "user@example.com"
 * }
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "message": "Dev access granted to user@example.com",
 *   "user": { "user_id": "uuid", "email": "user@example.com", "exafy_admin": true }
 * }
 */
router.post('/grant', async (req: Request, res: Response) => {
  // Verify caller is exafy_admin
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({
      ok: false,
      error: authResult.error,
    });
  }

  const { email } = req.body;

  if (!email || typeof email !== 'string' || email.trim() === '') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'email is required and must be a non-empty string',
    });
  }

  const targetEmail = email.trim().toLowerCase();

  // Look up the target user
  const userResult = await lookupUserByEmail(targetEmail);
  if (!userResult.ok) {
    if (userResult.error === 'USER_NOT_FOUND') {
      return res.status(404).json({
        ok: false,
        error: 'USER_NOT_FOUND',
        message: `User with email ${targetEmail} not found`,
      });
    }
    return res.status(userResult.status).json({
      ok: false,
      error: userResult.error,
    });
  }

  const targetUser = userResult.user;

  // Check if already exafy_admin
  if (targetUser.app_metadata?.exafy_admin === true) {
    return res.status(200).json({
      ok: true,
      message: `User ${targetEmail} already has dev access`,
      user: {
        user_id: targetUser.id,
        email: targetUser.email,
        exafy_admin: true,
      },
    });
  }

  // Update user's app_metadata to set exafy_admin=true
  const supabase = getSupabase();
  if (!supabase) {
    console.error(`[${VTID}] Supabase service role client not available`);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration missing',
    });
  }

  try {
    const { data: updateData, error: updateError } = await supabase.auth.admin.updateUserById(
      targetUser.id,
      {
        app_metadata: {
          ...targetUser.app_metadata,
          exafy_admin: true,
        },
      }
    );

    if (updateError) {
      console.error(`[${VTID}] Error updating user:`, updateError.message);
      return res.status(500).json({
        ok: false,
        error: 'UPDATE_FAILED',
        message: updateError.message,
      });
    }

    console.log(`[${VTID}] POST /grant - Dev access granted to ${targetEmail} by ${authResult.email}`);

    // Emit OASIS event (async, non-blocking)
    emitDevAccessEvent('grant', targetEmail, authResult.email).catch((err) => {
      console.warn(`[${VTID}] OASIS event emission failed:`, err);
    });

    return res.status(200).json({
      ok: true,
      message: `Dev access granted to ${targetEmail}`,
      user: {
        user_id: targetUser.id,
        email: targetUser.email,
        exafy_admin: true,
      },
    });
  } catch (err: any) {
    console.error(`[${VTID}] Grant error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * POST /revoke
 *
 * Revoke dev access (set exafy_admin=false) from a user by email.
 *
 * Body:
 * {
 *   "email": "user@example.com"
 * }
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "message": "Dev access revoked from user@example.com",
 *   "user": { "user_id": "uuid", "email": "user@example.com", "exafy_admin": false }
 * }
 */
router.post('/revoke', async (req: Request, res: Response) => {
  // Verify caller is exafy_admin
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({
      ok: false,
      error: authResult.error,
    });
  }

  const { email } = req.body;

  if (!email || typeof email !== 'string' || email.trim() === '') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'email is required and must be a non-empty string',
    });
  }

  const targetEmail = email.trim().toLowerCase();

  // Prevent self-revocation
  if (targetEmail === authResult.email.toLowerCase()) {
    return res.status(400).json({
      ok: false,
      error: 'SELF_REVOKE_FORBIDDEN',
      message: 'Cannot revoke your own dev access',
    });
  }

  // Look up the target user
  const userResult = await lookupUserByEmail(targetEmail);
  if (!userResult.ok) {
    if (userResult.error === 'USER_NOT_FOUND') {
      return res.status(404).json({
        ok: false,
        error: 'USER_NOT_FOUND',
        message: `User with email ${targetEmail} not found`,
      });
    }
    return res.status(userResult.status).json({
      ok: false,
      error: userResult.error,
    });
  }

  const targetUser = userResult.user;

  // Check if already not exafy_admin
  if (targetUser.app_metadata?.exafy_admin !== true) {
    return res.status(200).json({
      ok: true,
      message: `User ${targetEmail} already does not have dev access`,
      user: {
        user_id: targetUser.id,
        email: targetUser.email,
        exafy_admin: false,
      },
    });
  }

  // Update user's app_metadata to set exafy_admin=false
  const supabase = getSupabase();
  if (!supabase) {
    console.error(`[${VTID}] Supabase service role client not available`);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Supabase configuration missing',
    });
  }

  try {
    const { data: updateData, error: updateError } = await supabase.auth.admin.updateUserById(
      targetUser.id,
      {
        app_metadata: {
          ...targetUser.app_metadata,
          exafy_admin: false,
        },
      }
    );

    if (updateError) {
      console.error(`[${VTID}] Error updating user:`, updateError.message);
      return res.status(500).json({
        ok: false,
        error: 'UPDATE_FAILED',
        message: updateError.message,
      });
    }

    console.log(`[${VTID}] POST /revoke - Dev access revoked from ${targetEmail} by ${authResult.email}`);

    // Emit OASIS event (async, non-blocking)
    emitDevAccessEvent('revoke', targetEmail, authResult.email).catch((err) => {
      console.warn(`[${VTID}] OASIS event emission failed:`, err);
    });

    return res.status(200).json({
      ok: true,
      message: `Dev access revoked from ${targetEmail}`,
      user: {
        user_id: targetUser.id,
        email: targetUser.email,
        exafy_admin: false,
      },
    });
  } catch (err: any) {
    console.error(`[${VTID}] Revoke error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

export default router;
