/**
 * L2.2a (VTID-02982 / orb-live-refactor): backend LiveKit Agent readiness flag.
 *
 * The L2.2a safety pin: even when a canary user is fully allowlisted AND
 * LiveKit credentials are valid, the per-identity active-provider resolver
 * keeps `effectiveProvider=vertex` until THIS flag is true. The flag means
 * "a backend LiveKit Agent (the room participant that runs Gemini and
 * publishes audio back to the LiveKit room) is running and ready to serve."
 *
 * L2.2a ships with the agent NOT YET BUILT — the flag is off by default and
 * stays off in production. When L2.2b ships the agent service, ops flips
 * the flag and canary users start routing to LiveKit via the existing
 * `/orb/active-provider` endpoint, no frontend redeploy needed.
 *
 * Inputs (either unlocks the agent):
 *   - env  `ORB_LIVEKIT_AGENT_ENABLED` (`true | 1 | yes` case-insensitive)
 *   - sys  `voice.livekit_agent_enabled` (boolean) system_config row
 *
 * Hard rules:
 *   - This helper NEVER throws. DB failures degrade to `enabled: false`
 *     (production-safe default — pins to Vertex).
 *   - It is a discrete knob from the canary config in
 *     `livekit-canary-config.ts`. Mixing them would conflate "WHO is on the
 *     canary" with "is the backend AGENT itself ready" — different
 *     decisions, different flip cadences.
 */

import { getSupabase } from '../../../lib/supabase';

export interface LiveKitAgentReadiness {
  enabled: boolean;
}

const CACHE_TTL_MS = 15_000;
const AGENT_ENABLED_KEY = 'voice.livekit_agent_enabled';

let _cached: LiveKitAgentReadiness | null = null;
let _cachedAt = 0;

function envEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.ORB_LIVEKIT_AGENT_ENABLED ?? '').trim().toLowerCase();
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

/**
 * Read the LiveKit Agent readiness flag. Cached 15s.
 * NEVER throws — DB failures degrade to `{enabled:false}` so the resolver
 * pins to Vertex.
 */
export async function getLiveKitAgentReadiness(
  env: NodeJS.ProcessEnv = process.env,
  force = false,
): Promise<LiveKitAgentReadiness> {
  const now = Date.now();
  if (!force && _cached && now - _cachedAt < CACHE_TTL_MS) {
    // Env flag always overrides cache (operator can flip it without
    // invalidating the cached system_config row).
    const envOn = envEnabled(env);
    return envOn && !_cached.enabled ? { enabled: true } : _cached;
  }

  const envOn = envEnabled(env);
  const sb = getSupabase();
  if (!sb) {
    const cfg: LiveKitAgentReadiness = { enabled: envOn };
    _cached = cfg;
    _cachedAt = now;
    return cfg;
  }

  let sysEnabled = false;
  try {
    const { data, error } = await sb
      .from('system_config')
      .select('key, value')
      .eq('key', AGENT_ENABLED_KEY)
      .maybeSingle();
    if (!error && data) {
      sysEnabled = asBool((data as { value: unknown }).value);
    }
  } catch {
    // Degrade to env-only (or false) — production-safe.
  }

  const cfg: LiveKitAgentReadiness = { enabled: envOn || sysEnabled };
  _cached = cfg;
  _cachedAt = now;
  return cfg;
}

export function invalidateLiveKitAgentConfigCache(): void {
  _cached = null;
  _cachedAt = 0;
}
