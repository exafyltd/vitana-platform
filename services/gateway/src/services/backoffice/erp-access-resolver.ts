/**
 * VTID-03848 — effective ERP access for a caller, usable from routes AND from
 * the ORB tool dispatcher (which has a session identity, not an Express
 * request). Moved verbatim out of routes/backoffice-access.ts (VTID-03834),
 * which now re-exports it, so route and voice resolve access identically.
 */
import { effectiveCapabilities, type EffectiveAccess } from './erp-access';

const VTID = 'VTID-03834';
const TABLE = 'erp_capability_grants';

export interface GrantRow { user_id: string; tenant_id: string; capability: string; granted_by: string | null; granted_at: string }

export interface AccessCaller {
  user_id: string;
  is_exafy_admin: boolean;
  tenant_id: string | null;
  active_role: string | null;
}

export function serviceCreds(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

export async function fetchGrants(tenantId: string, userId?: string): Promise<GrantRow[]> {
  const creds = serviceCreds();
  if (!creds) throw new Error('SERVICE_CONFIG');
  let url = `${creds.url}/rest/v1/${TABLE}?tenant_id=eq.${encodeURIComponent(tenantId)}&select=user_id,tenant_id,capability,granted_by,granted_at&order=capability.asc`;
  if (userId) url += `&user_id=eq.${encodeURIComponent(userId)}`;
  const response = await fetch(url, { headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` } });
  if (!response.ok) throw new Error(`GRANTS_FETCH_${response.status}`);
  return (await response.json()) as GrantRow[];
}

/** Resolve the caller's effective access (role defaults ∪ explicit grants in their tenant). */
export async function resolveAccess(auth: AccessCaller): Promise<EffectiveAccess> {
  let explicit: string[] = [];
  if (auth.tenant_id) {
    try {
      explicit = (await fetchGrants(auth.tenant_id, auth.user_id)).map((r) => r.capability);
    } catch (err: any) {
      console.error(`[${VTID}] explicit grants fetch failed:`, err.message);
      // fail closed on explicit grants, but role defaults still apply
    }
  }
  return effectiveCapabilities(auth.active_role, auth.is_exafy_admin, explicit);
}
