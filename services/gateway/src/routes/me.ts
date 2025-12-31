import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { randomUUID } from 'crypto';

const router = Router();

// VTID-01048: Valid roles for active_role validation
// VTID-01074: Added 'infra' role for platform infrastructure
const VALID_ROLES = ['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'];

// VTID-01074: Tenant slug mapping (tenant_id -> slug)
// These are the known tenant slugs in the Vitana ecosystem
const TENANT_SLUGS: Record<string, string> = {
  '00000000-0000-0000-0000-000000000001': 'vitana',
  '00000000-0000-0000-0000-000000000002': 'maxina',
  '00000000-0000-0000-0000-000000000003': 'alkalma',
  '00000000-0000-0000-0000-000000000004': 'earthlings',
};

// VTID-01074: Reverse mapping (slug -> tenant_id)
const SLUG_TO_TENANT_ID: Record<string, string> = {
  'vitana': '00000000-0000-0000-0000-000000000001',
  'maxina': '00000000-0000-0000-0000-000000000002',
  'alkalma': '00000000-0000-0000-0000-000000000003',
  'earthlings': '00000000-0000-0000-0000-000000000004',
};

/**
 * VTID-01074: Emit OASIS event for context operations.
 */
async function emitOasisEvent(topic: string, vtid: string, message: string, metadata: Record<string, any>): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[${vtid}] Cannot emit OASIS event: missing Supabase credentials`);
    return;
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const payload = {
    id: eventId,
    created_at: timestamp,
    vtid,
    topic,
    service: 'gateway-me-context',
    role: 'GATEWAY',
    model: 'me-context',
    status: 'success',
    message,
    link: null,
    metadata: {
      ...metadata,
      emitted_at: timestamp,
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
      console.warn(`[${vtid}] Failed to emit OASIS event: ${response.status} - ${errorText}`);
    } else {
      console.log(`[${vtid}] OASIS event emitted: ${topic} (${eventId})`);
    }
  } catch (error) {
    console.warn(`[${vtid}] Error emitting OASIS event:`, error);
  }
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
 * VTID-01048: Helper to normalize RPC response to canonical me format.
 * Maps backend RPC response to the authoritative me context format.
 */
function normalizeToMeContext(rpcData: any): {
  user_id: string | null;
  email: string | null;
  tenant_id: string | null;
  roles: string[];
  active_role: string | null;
  active_role_source: string;
  ts: string;
} {
  return {
    user_id: rpcData?.user_id || rpcData?.id || null,
    email: rpcData?.email || null,
    tenant_id: rpcData?.tenant_id || null,
    roles: Array.isArray(rpcData?.roles)
      ? rpcData.roles
      : Array.isArray(rpcData?.available_roles)
        ? rpcData.available_roles
        : VALID_ROLES,
    active_role: rpcData?.active_role || null,
    active_role_source: 'supabase_rpc',
    ts: new Date().toISOString(),
  };
}

/**
 * VTID-01048: GET /
 * Returns the authoritative identity + role context for the current user.
 * This is the single source of truth for user_id + tenant + roles + active_role.
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "me": {
 *     "user_id": "uuid",
 *     "email": "string|null",
 *     "tenant_id": "string|null",
 *     "roles": ["community","patient","professional","staff","admin","developer"],
 *     "active_role": "admin",
 *     "active_role_source": "supabase_rpc",
 *     "ts": "iso"
 *   }
 * }
 *
 * Errors:
 * - 401: { ok: false, error: "UNAUTHENTICATED" }
 */
router.get('/', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01048] GET /me - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      console.error('[VTID-01048] GET /me - RPC error:', error.message);
      // Check if it's an auth error
      if (error.message.includes('JWT') || error.message.includes('auth') || error.code === 'PGRST301') {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
        });
      }
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }

    console.log('[VTID-01048] GET /me - Success');
    return res.status(200).json({
      ok: true,
      me: normalizeToMeContext(data),
    });
  } catch (err: any) {
    console.error('[VTID-01048] GET /me - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * VTID-01074: GET /context
 * Returns the authoritative user context for RLS/GUC operations.
 * This is the canonical endpoint for resolving tenant/user/role context.
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "tenant_id": "uuid",
 *   "user_id": "uuid",
 *   "active_role": "string",
 *   "tenant_slug": "vitana|maxina|alkalma|earthlings"
 * }
 *
 * Errors:
 * - 401: { ok: false, error: "UNAUTHENTICATED" }
 */
router.get('/context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01074] GET /me/context - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      console.error('[VTID-01074] GET /me/context - RPC error:', error.message);
      // Check if it's an auth error
      if (error.message.includes('JWT') || error.message.includes('auth') || error.code === 'PGRST301') {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
        });
      }
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }

    // VTID-01074: Extract authoritative context and resolve tenant_slug
    const tenantId = data?.tenant_id || null;
    const userId = data?.user_id || data?.id || null;
    const activeRole = data?.active_role || null;
    const tenantSlug = tenantId ? (TENANT_SLUGS[tenantId] || null) : null;

    // Emit OASIS event (async, non-blocking)
    emitOasisEvent(
      'me.context.access',
      'VTID-01074',
      `Context accessed for user ${userId}`,
      { user_id: userId, tenant_id: tenantId, active_role: activeRole, tenant_slug: tenantSlug }
    ).catch((err) => console.warn('[VTID-01074] OASIS event failed:', err));

    console.log('[VTID-01074] GET /me/context - Success');
    return res.status(200).json({
      ok: true,
      tenant_id: tenantId,
      user_id: userId,
      active_role: activeRole,
      tenant_slug: tenantSlug,
    });
  } catch (err: any) {
    console.error('[VTID-01074] GET /me/context - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * VTID-01074: POST /active-role
 * Persists a role change server-side for the current user+tenant.
 * Calls Supabase RPC: me_set_active_role(p_role)
 * Returns updated context in VTID-01074 authoritative format.
 *
 * Request: { "active_role": "developer" }
 *   (Also accepts legacy format: { "role": "developer" })
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "tenant_id": "uuid",
 *   "user_id": "uuid",
 *   "active_role": "string",
 *   "tenant_slug": "vitana|maxina|alkalma|earthlings"
 * }
 *
 * Errors:
 * - 400 INVALID_ROLE
 * - 401 UNAUTHENTICATED
 * - 403 FORBIDDEN (if role not allowed for that user)
 */
router.post('/active-role', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01074] POST /me/active-role - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  // VTID-01074: Accept both 'active_role' (preferred) and 'role' (legacy)
  const roleValue = req.body.active_role || req.body.role;

  // Validate role is one of the allowed values
  if (!roleValue || !VALID_ROLES.includes(roleValue)) {
    console.warn('[VTID-01074] POST /me/active-role - Invalid role:', roleValue);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_ROLE',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Set the active role via RPC
    const { error: setError } = await supabase.rpc('me_set_active_role', { p_role: roleValue });

    if (setError) {
      console.error('[VTID-01074] POST /me/active-role - RPC set error:', setError.message);

      // Check for authentication errors
      if (setError.message.includes('JWT') || setError.message.includes('auth') || setError.code === 'PGRST301') {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
        });
      }

      // Check for forbidden/permission errors (role not allowed for user)
      if (setError.message.includes('forbidden') || setError.message.includes('permission') || setError.message.includes('not allowed')) {
        return res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
        });
      }

      return res.status(400).json({
        ok: false,
        error: setError.message,
      });
    }

    // Fetch fresh me_context after setting role
    const { data: contextData, error: contextError } = await supabase.rpc('me_context');

    if (contextError) {
      console.error('[VTID-01074] POST /me/active-role - RPC context error:', contextError.message);
      return res.status(400).json({
        ok: false,
        error: contextError.message,
      });
    }

    // VTID-01074: Extract authoritative context and resolve tenant_slug
    const tenantId = contextData?.tenant_id || null;
    const userId = contextData?.user_id || contextData?.id || null;
    const activeRole = contextData?.active_role || roleValue;
    const tenantSlug = tenantId ? (TENANT_SLUGS[tenantId] || null) : null;

    // Emit OASIS event (async, non-blocking)
    emitOasisEvent(
      'me.active_role.set',
      'VTID-01074',
      `Active role set to ${activeRole} for user ${userId}`,
      { user_id: userId, tenant_id: tenantId, active_role: activeRole, tenant_slug: tenantSlug }
    ).catch((err) => console.warn('[VTID-01074] OASIS event failed:', err));

    console.log('[VTID-01074] POST /me/active-role - Success, role set to:', roleValue);
    return res.status(200).json({
      ok: true,
      tenant_id: tenantId,
      user_id: userId,
      active_role: activeRole,
      tenant_slug: tenantSlug,
    });
  } catch (err: any) {
    console.error('[VTID-01074] POST /me/active-role - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

export default router;
