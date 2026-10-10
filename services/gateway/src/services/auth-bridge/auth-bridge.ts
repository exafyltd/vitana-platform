/**
 * VTID-05023 part 4 — auth -> Aurora bridge (owner decision R2 accepted).
 *
 * After the cutover GoTrue (auth.users) stays on Supabase while `public` lives
 * on Aurora. The six AFTER INSERT triggers that provisioned every new member
 * in `public` are disabled on Supabase at the flip
 * (scripts/aws/supabase-cutover-auth-bridge.sql) and the same provisioning
 * runs on Aurora in `public.ensure_provisioned()`
 * (scripts/aws/aurora-cutover-auth-bridge.sql), reached three ways, all
 * idempotent:
 *   (a) PostgREST db-pre-request on Aurora (members' own read-write requests);
 *   (b) the auth.users webhook -> POST /api/v1/internal/auth-bridge/user-event
 *       (routes/auth-bridge.ts);
 *   (c) the reconciliation job (auth-bridge-reconciler.ts).
 * Plus `ensureProvisioned(userId)`, which the gateway awaits before its own
 * service-role writes for a brand-new member (service_role requests never
 * trigger (a)).
 *
 * Server-to-server only: `SUPABASE_URL` is the gateway's data origin (the
 * internal proxy after the cutover — `/rest/v1` is Aurora, `/auth/v1` passes
 * through to GoTrue on Supabase).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';

/** The subset of an auth user the bridge needs (GoTrue admin API or webhook). */
export interface BridgeAuthUser {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  created_at: string | null;
  email_confirmed_at: string | null;
}

/** What `public.ensure_provisioned()` returns. */
export interface EnsureProvisionedResult {
  user_id: string;
  created: string[];
  provisioned: boolean;
  active_tenant_id: string | null;
}

/** Aurora side (PostgREST, service role). */
export interface AuthBridgeStore {
  ensureProvisioned(user: BridgeAuthUser): Promise<EnsureProvisionedResult>;
  handleDeletedUser(userId: string, source: string): Promise<Record<string, unknown>>;
  /** Of these ids, the ones with no app_users row (registered test/service accounts excluded). */
  unprovisioned(userIds: string[]): Promise<string[]>;
  appUserExists(userId: string): Promise<boolean>;
  /** profiles.user_id ordered by user_id, `limit` rows from `offset`. */
  listProfileUserIds(offset: number, limit: number): Promise<string[]>;
  /** Of these ids, the ones auth_bridge_handle_deleted_user() already processed. */
  processedDeletions(userIds: string[]): Promise<Set<string>>;
}

/** Supabase side (GoTrue admin API, service role). */
export interface GoTrueAdmin {
  listUsers(page: number, perPage: number): Promise<BridgeAuthUser[]>;
  /** null when GoTrue answers 404 (the user does not exist); throws on any other failure. */
  getUser(userId: string): Promise<BridgeAuthUser | null>;
  /** Merges { active_tenant_id } into app_metadata (GoTrue merges app_metadata keys). */
  setActiveTenant(userId: string, tenantId: string): Promise<void>;
}

export interface AuthBridgeDeps {
  store: AuthBridgeStore;
  gotrue: GoTrueAdmin;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Normalises a GoTrue admin-API user or an auth.users webhook record. */
export function toBridgeAuthUser(raw: Record<string, any>): BridgeAuthUser {
  return {
    id: String(raw.id),
    email: typeof raw.email === 'string' && raw.email ? raw.email : null,
    user_metadata: asObject(raw.user_metadata ?? raw.raw_user_meta_data),
    app_metadata: asObject(raw.app_metadata ?? raw.raw_app_meta_data),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : null,
    email_confirmed_at: typeof raw.email_confirmed_at === 'string' ? raw.email_confirmed_at : null,
  };
}

export type ProvisionOutcome = EnsureProvisionedResult & { active_tenant_set: boolean };

/**
 * Provisions one auth user on Aurora and, like handle_new_user() did with its
 * UPDATE auth.users, records active_tenant_id in the user's app_metadata —
 * only when it is missing, so a member's own tenant switch is never undone.
 * Throws on failure (callers decide how loud).
 */
export async function provisionAuthUser(deps: AuthBridgeDeps, user: BridgeAuthUser): Promise<ProvisionOutcome> {
  const result = await deps.store.ensureProvisioned(user);
  let activeTenantSet = false;
  if (result.active_tenant_id && !user.app_metadata?.active_tenant_id) {
    await deps.gotrue.setActiveTenant(user.id, result.active_tenant_id);
    activeTenantSet = true;
  }
  return { ...result, active_tenant_set: activeTenantSet };
}

// ── Default implementation: PostgREST + GoTrue admin over SUPABASE_URL ──────

interface PostgrestLike {
  rpc: SupabaseClient['rpc'];
  from: SupabaseClient['from'];
}

export function supabaseStore(sb: PostgrestLike): AuthBridgeStore {
  return {
    async ensureProvisioned(user) {
      const { data, error } = await sb.rpc('ensure_provisioned', {
        p_user_id: user.id,
        p_email: user.email,
        p_raw_user_meta: user.user_metadata ?? {},
        p_created_at: user.created_at,
      });
      if (error) throw new Error(`ensure_provisioned failed: ${error.message}`);
      const r = asObject(data);
      return {
        user_id: String(r.user_id ?? user.id),
        created: Array.isArray(r.created) ? (r.created as string[]) : [],
        provisioned: r.provisioned === true,
        active_tenant_id: typeof r.active_tenant_id === 'string' ? r.active_tenant_id : null,
      };
    },
    async handleDeletedUser(userId, source) {
      const { data, error } = await sb.rpc('auth_bridge_handle_deleted_user', { p_user_id: userId, p_source: source });
      if (error) throw new Error(`auth_bridge_handle_deleted_user failed: ${error.message}`);
      return asObject(data);
    },
    async unprovisioned(userIds) {
      if (userIds.length === 0) return [];
      const { data, error } = await sb.rpc('auth_bridge_unprovisioned', { p_user_ids: userIds });
      if (error) throw new Error(`auth_bridge_unprovisioned failed: ${error.message}`);
      return ((data as unknown[]) ?? []).map((row) =>
        typeof row === 'string' ? row : String(Object.values(asObject(row))[0]),
      );
    },
    async appUserExists(userId) {
      const { data, error } = await sb.from('app_users').select('user_id').eq('user_id', userId).limit(1);
      if (error) throw new Error(`app_users lookup failed: ${error.message}`);
      return Array.isArray(data) && data.length > 0;
    },
    async listProfileUserIds(offset, limit) {
      const { data, error } = await sb
        .from('profiles')
        .select('user_id')
        .order('user_id', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw new Error(`profiles page failed: ${error.message}`);
      return ((data as Array<{ user_id: string }>) ?? []).map((r) => r.user_id);
    },
    async processedDeletions(userIds) {
      if (userIds.length === 0) return new Set();
      const { data, error } = await sb.from('auth_bridge_deleted_users').select('user_id').in('user_id', userIds);
      if (error) throw new Error(`auth_bridge_deleted_users lookup failed: ${error.message}`);
      return new Set(((data as Array<{ user_id: string }>) ?? []).map((r) => r.user_id));
    },
  };
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export function goTrueAdmin(
  baseUrl: string,
  serviceKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): GoTrueAdmin {
  const root = `${baseUrl.replace(/\/+$/, '')}/auth/v1/admin/users`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const fail = async (what: string, res: { status: number; text(): Promise<string> }) => {
    const body = await res.text().catch(() => '');
    return new Error(`GoTrue ${what} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  };
  return {
    async listUsers(page, perPage) {
      const res = await fetchImpl(`${root}?page=${page}&per_page=${perPage}`, { headers });
      if (!res.ok) throw await fail('list users', res);
      const body = await res.json();
      const users = Array.isArray(body?.users) ? body.users : [];
      return users.map((u: Record<string, any>) => toBridgeAuthUser(u));
    },
    async getUser(userId) {
      const res = await fetchImpl(`${root}/${encodeURIComponent(userId)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw await fail('get user', res);
      return toBridgeAuthUser(await res.json());
    },
    async setActiveTenant(userId, tenantId) {
      const res = await fetchImpl(`${root}/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ app_metadata: { active_tenant_id: tenantId } }),
      });
      if (!res.ok) throw await fail('update app_metadata', res);
    },
  };
}

let depsOverride: AuthBridgeDeps | null = null;

/** Test seam: replace the PostgREST/GoTrue implementation (null restores it). */
export function setAuthBridgeDepsForTests(deps: AuthBridgeDeps | null): void {
  depsOverride = deps;
  provisionedCache.clear();
  inFlight.clear();
}

/** The bridge's dependencies, or null when the gateway has no Supabase service credentials. */
export function getAuthBridgeDeps(env: NodeJS.ProcessEnv = process.env): AuthBridgeDeps | null {
  if (depsOverride) return depsOverride;
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE;
  const sb = getSupabase();
  if (!url || !key || !sb) return null;
  return { store: supabaseStore(sb), gotrue: goTrueAdmin(url, key) };
}

// ── ensureProvisioned(userId): the gateway's own write paths ────────────────

/**
 * On only when AUTH_BRIDGE_ENABLED=true (set at the cutover flip). Before the
 * cutover the Supabase triggers still provision every member and
 * ensure_provisioned() does not exist on Supabase, so the helper stays inert.
 */
export function isAuthBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AUTH_BRIDGE_ENABLED || '').trim().toLowerCase() === 'true';
}

export type EnsureProvisionedOutcome =
  | 'disabled'
  | 'invalid_user_id'
  | 'cached'
  | 'exists'
  | 'provisioned'
  | 'no_auth_user'
  | 'unavailable'
  | 'error';

const PROVISIONED_CACHE_MAX = 20_000;
const provisionedCache = new Set<string>();
const inFlight = new Map<string, Promise<EnsureProvisionedOutcome>>();

function remember(userId: string): void {
  if (provisionedCache.size >= PROVISIONED_CACHE_MAX) provisionedCache.clear();
  provisionedCache.add(userId);
}

/**
 * Makes sure `userId` has its `public` rows on Aurora before the gateway
 * writes on the member's behalf. Cheap when provisioned (one indexed lookup,
 * then an in-process cache); otherwise reads the user from GoTrue and runs
 * ensure_provisioned(). Never throws: a failure is logged loudly and the
 * caller carries on exactly as it would have (the webhook and the
 * reconciliation job retry).
 */
export async function ensureProvisioned(userId: string | null | undefined): Promise<EnsureProvisionedOutcome> {
  if (!isAuthBridgeEnabled()) return 'disabled';
  if (!isUuid(userId)) return 'invalid_user_id';
  if (provisionedCache.has(userId)) return 'cached';
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const run = (async (): Promise<EnsureProvisionedOutcome> => {
    const deps = getAuthBridgeDeps();
    if (!deps) {
      console.error(`[VTID-05023] ensureProvisioned(${userId}): no Supabase service credentials — not provisioned`);
      return 'unavailable';
    }
    try {
      if (await deps.store.appUserExists(userId)) {
        remember(userId);
        return 'exists';
      }
      const user = await deps.gotrue.getUser(userId);
      if (!user) {
        console.warn(`[VTID-05023] ensureProvisioned(${userId}): no such auth user — not provisioned`);
        return 'no_auth_user';
      }
      const outcome = await provisionAuthUser(deps, user);
      remember(userId);
      console.log(
        `[VTID-05023] ensureProvisioned(${userId}): provisioned [${outcome.created.join(', ')}]` +
          (outcome.active_tenant_set ? `, active_tenant_id=${outcome.active_tenant_id}` : ''),
      );
      return 'provisioned';
    } catch (err: any) {
      console.error(`[VTID-05023] ensureProvisioned(${userId}) failed: ${err?.message ?? err}`);
      return 'error';
    }
  })();
  inFlight.set(userId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(userId);
  }
}
