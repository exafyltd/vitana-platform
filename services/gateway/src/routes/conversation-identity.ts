/**
 * VTID-04447: bind the Conversation API to the caller's verified identity.
 *
 * `POST /api/v1/conversation/turn` and `/stream` used to take `user_id` and
 * `tenant_id` from the request body with no authentication. Those two fields
 * decide whose memory is read into the prompt, whose memory the turn writes,
 * and (for the developer_assistant channel) whose role is checked. So anyone
 * could read another member's memory, write facts into it, or pass the
 * developer check by naming a developer's user id.
 *
 * Every route now runs requireAuth first, then this binder:
 *   - user_id comes from the JWT. A different user_id in the request is
 *     refused (403 IDENTITY_MISMATCH), never silently replaced, so a client
 *     bug or a spoof attempt is visible.
 *   - tenant_id defaults to the JWT's active tenant. Another tenant is allowed
 *     only when the caller is a member of it (user_tenants row).
 */

import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { fetchVerifiedActiveRole } from './conversation-repository';

export type MembershipCheck = (userId: string, tenantId: string) => Promise<boolean>;

export type IdentityDecision =
  | { ok: true; user_id: string; tenant_id: string | null }
  | { ok: false; status: number; error: string; message: string };

async function defaultMembershipCheck(userId: string, tenantId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { data, error } = await fetchVerifiedActiveRole(supabase, userId, tenantId);
    return !error && !!data;
  } catch {
    return false;
  }
}

/** Decide the effective user/tenant for a request. Pure apart from the membership check. */
export async function resolveConversationIdentity(
  identity: { user_id: string; tenant_id: string | null } | undefined,
  requested: { user_id?: unknown; tenant_id?: unknown },
  isMember: MembershipCheck = defaultMembershipCheck,
): Promise<IdentityDecision> {
  if (!identity?.user_id) {
    return { ok: false, status: 401, error: 'UNAUTHENTICATED', message: 'Authentication required' };
  }
  const reqUser = typeof requested.user_id === 'string' && requested.user_id ? requested.user_id : null;
  if (reqUser && reqUser !== identity.user_id) {
    return {
      ok: false,
      status: 403,
      error: 'IDENTITY_MISMATCH',
      message: 'user_id does not match the authenticated user',
    };
  }
  const reqTenant = typeof requested.tenant_id === 'string' && requested.tenant_id ? requested.tenant_id : null;
  if (!reqTenant || reqTenant === identity.tenant_id) {
    return { ok: true, user_id: identity.user_id, tenant_id: identity.tenant_id };
  }
  if (await isMember(identity.user_id, reqTenant)) {
    return { ok: true, user_id: identity.user_id, tenant_id: reqTenant };
  }
  return {
    ok: false,
    status: 403,
    error: 'TENANT_FORBIDDEN',
    message: 'The authenticated user is not a member of this tenant',
  };
}

function refuse(res: Response, d: Extract<IdentityDecision, { ok: false }>): void {
  res.status(d.status).json({ ok: false, error: d.error, message: d.message });
}

/** For POST routes: rewrites req.body.user_id / tenant_id to the verified values. */
export function bindConversationBodyIdentity(isMember: MembershipCheck = defaultMembershipCheck) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const d = await resolveConversationIdentity(req.identity, body, isMember);
    if (!d.ok) return refuse(res, d);
    req.body = { ...body, user_id: d.user_id, ...(d.tenant_id ? { tenant_id: d.tenant_id } : {}) };
    next();
  };
}

/** For GET routes: rewrites req.query.user_id / tenant_id to the verified values. */
export function bindConversationQueryIdentity(isMember: MembershipCheck = defaultMembershipCheck) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const q = req.query as Record<string, unknown>;
    const d = await resolveConversationIdentity(req.identity, q, isMember);
    if (!d.ok) return refuse(res, d);
    q.user_id = d.user_id;
    if (d.tenant_id) q.tenant_id = d.tenant_id;
    next();
  };
}
