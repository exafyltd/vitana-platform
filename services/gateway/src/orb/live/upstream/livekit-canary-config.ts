/**
 * L2.1 (VTID-02980 / orb-live-refactor): LiveKit internal-canary config reader.
 *
 * The L1 upstream provider selector is pure — it accepts canary configuration
 * via its `ctx.canary` field. This helper computes that field for the live
 * `connectToLiveAPI` path:
 *
 *   - `enabled` — true iff EITHER `process.env.ORB_LIVEKIT_CANARY_ENABLED === 'true'`
 *      OR the `voice.livekit_canary_enabled` system_config row is `true`. Either
 *      source can unlock the canary; both must be falsy for the L1 pin to hold.
 *   - `allowedTenants` / `allowedUsers` — read from the `voice.livekit_canary_allowlist`
 *      system_config row. Expected JSONB shape:
 *        { "tenants": ["uuid", ...], "users": ["uuid", ...] }
 *      Either array may be absent / empty. A canary with `enabled=true` but an
 *      empty allowlist matches NO identities and produces `canary_not_allowlisted`
 *      for every LiveKit-requested session — explicit rollback is one env flip OR
 *      one allowlist clear.
 *
 * In-process cache (~15s TTL) so the helper can be called inline on every
 * session start without thrashing Supabase. Cache is invalidated explicitly
 * via `invalidateLiveKitCanaryConfigCache()` after an admin change.
 *
 * Hard rules:
 *   - This helper NEVER throws — DB failures degrade to `{enabled: false}`
 *     so the selector pins to Vertex (production-safe default).
 *   - It NEVER consults `voice.active_provider` — that lookup is owned by
 *     `voice-config.ts` and feeds the selector separately. Canary state is
 *     its own knob, so flipping `voice.active_provider` to `livekit` does NOT
 *     by itself unlock the canary.
 */

import { getSupabase } from '../../../lib/supabase';

export interface LiveKitCanaryConfig {
  enabled: boolean;
  allowedTenants: string[];
  allowedUsers: string[];
}

const CACHE_TTL_MS = 15_000;
const ENABLED_KEY = 'voice.livekit_canary_enabled';
const ALLOWLIST_KEY = 'voice.livekit_canary_allowlist';

let _cached: LiveKitCanaryConfig | null = null;
let _cachedAt = 0;

function envEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.ORB_LIVEKIT_CANARY_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  if (
    v &&
    typeof v === 'object' &&
    'enabled' in (v as Record<string, unknown>) &&
    typeof (v as Record<string, unknown>).enabled === 'boolean'
  ) {
    return (v as Record<string, boolean>).enabled;
  }
  return false;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function parseAllowlist(v: unknown): { tenants: string[]; users: string[] } {
  if (!v || typeof v !== 'object') return { tenants: [], users: [] };
  const obj = v as Record<string, unknown>;
  return {
    tenants: asStringArray(obj.tenants),
    users: asStringArray(obj.users),
  };
}

/**
 * Read the LiveKit canary config. Result is cached for 15s.
 * NEVER throws — DB failures degrade to `{enabled: false}` so the selector
 * pins to Vertex.
 */
export async function getLiveKitCanaryConfig(
  env: NodeJS.ProcessEnv = process.env,
  force = false,
): Promise<LiveKitCanaryConfig> {
  const now = Date.now();
  if (!force && _cached && now - _cachedAt < CACHE_TTL_MS) {
    // Even when cached, the env switch should override: env can flip
    // enabled→true without invalidating cache.
    const envOn = envEnabled(env);
    return envOn && !_cached.enabled
      ? { ..._cached, enabled: true }
      : _cached;
  }

  const envOn = envEnabled(env);

  const sb = getSupabase();
  if (!sb) {
    const cfg: LiveKitCanaryConfig = {
      enabled: envOn,
      allowedTenants: [],
      allowedUsers: [],
    };
    _cached = cfg;
    _cachedAt = now;
    return cfg;
  }

  let sysEnabled = false;
  let tenants: string[] = [];
  let users: string[] = [];
  try {
    const { data, error } = await sb
      .from('system_config')
      .select('key, value')
      .in('key', [ENABLED_KEY, ALLOWLIST_KEY]);
    if (!error && Array.isArray(data)) {
      for (const row of data as Array<{ key: string; value: unknown }>) {
        if (row.key === ENABLED_KEY) {
          sysEnabled = asBool(row.value);
        } else if (row.key === ALLOWLIST_KEY) {
          const al = parseAllowlist(row.value);
          tenants = al.tenants;
          users = al.users;
        }
      }
    }
  } catch {
    // Degrade to defaults — production-safe.
  }

  const cfg: LiveKitCanaryConfig = {
    enabled: envOn || sysEnabled,
    allowedTenants: tenants,
    allowedUsers: users,
  };
  _cached = cfg;
  _cachedAt = now;
  return cfg;
}

export function invalidateLiveKitCanaryConfigCache(): void {
  _cached = null;
  _cachedAt = 0;
}
