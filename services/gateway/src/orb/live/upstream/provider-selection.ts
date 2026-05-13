/**
 * Session B (orb-live-refactor): provider-selection seam for the
 * `UpstreamLiveClient`.
 *
 * Selects which provider implementation to construct for a new ORB Live
 * session. Pure functions — no side effects, no globals — so it can be
 * unit-tested with synthetic env objects and reused per-session if/when
 * tenant-level overrides land.
 *
 * Selection rules (checked in order):
 *   1. If `ORB_LIVE_PROVIDER` is unset → vertex (the default).
 *   2. If `ORB_LIVE_PROVIDER=vertex` → vertex.
 *   3. If `ORB_LIVE_PROVIDER=livekit` AND all of `LIVEKIT_URL`,
 *      `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` are set → livekit.
 *   4. If `ORB_LIVE_PROVIDER=livekit` but the credential triple is
 *      incomplete → vertex, with a warning describing what was missing.
 *   5. Any other value of `ORB_LIVE_PROVIDER` → vertex, with a warning
 *      naming the unrecognized value.
 *
 * Why fall back to vertex (not throw):
 *   - The whole point of the seam is that a misconfigured rollout cannot
 *     accidentally take voice down. Vertex is the proven path. Failures
 *     are surfaced via the `warnings` field so the caller can emit OASIS
 *     telemetry — they are NOT silent.
 *   - Matches the existing `services/gateway/src/orb/live/config.ts`
 *     pattern: read env, default sensibly, no result-type wrappers.
 *
 * Production note:
 *   - At time of writing, no production call site invokes this module.
 *     `routes/orb-live.ts` still calls its in-file `connectToLiveAPI`. The
 *     selection seam ships ahead of the call-site swap so the LiveKit
 *     skeleton can be exercised independently.
 */

import type { UpstreamLiveClient } from './types';
import { VertexLiveClient } from './vertex-live-client';
import {
  LiveKitLiveClient,
  type LiveKitClientConfig,
} from './livekit-live-client';

/** Recognized provider names. */
export type UpstreamProviderName = 'vertex' | 'livekit';

/**
 * Subset of `process.env` that the selector reads. Tests pass synthetic
 * objects; production callers pass `process.env` directly.
 */
export interface UpstreamProviderEnv {
  ORB_LIVE_PROVIDER?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

/**
 * Outcome of the selection. `provider` is always a recognized name —
 * even on fallback the caller gets a usable value. `warnings` lists
 * problems the caller should surface (typically via OASIS event).
 */
export interface UpstreamProviderSelection {
  /** Selected provider — always usable, never an error sentinel. */
  provider: UpstreamProviderName;
  /**
   * Where the choice came from. `'default'` = no env override applied;
   * `'env'` = an explicit ORB_LIVE_PROVIDER value was honored;
   * `'fallback'` = an env value was rejected and we substituted vertex.
   */
  source: 'default' | 'env' | 'fallback';
  /** Warnings the caller should log / emit as OASIS telemetry. */
  warnings: string[];
}

/**
 * Decide which upstream provider to use for the next session.
 *
 * Pure: same env in → same selection out. Safe to call per-session.
 */
export function selectUpstreamProvider(
  env: UpstreamProviderEnv = process.env as UpstreamProviderEnv,
): UpstreamProviderSelection {
  const raw = (env.ORB_LIVE_PROVIDER || '').trim().toLowerCase();

  if (raw === '' || raw === 'vertex') {
    return {
      provider: 'vertex',
      source: raw === '' ? 'default' : 'env',
      warnings: [],
    };
  }

  if (raw === 'livekit') {
    const missing: string[] = [];
    if (!env.LIVEKIT_URL || !env.LIVEKIT_URL.trim()) missing.push('LIVEKIT_URL');
    if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_KEY.trim())
      missing.push('LIVEKIT_API_KEY');
    if (!env.LIVEKIT_API_SECRET || !env.LIVEKIT_API_SECRET.trim())
      missing.push('LIVEKIT_API_SECRET');

    if (missing.length === 0) {
      return { provider: 'livekit', source: 'env', warnings: [] };
    }

    return {
      provider: 'vertex',
      source: 'fallback',
      warnings: [
        `ORB_LIVE_PROVIDER=livekit but missing required env: ${missing.join(', ')} — falling back to vertex`,
      ],
    };
  }

  return {
    provider: 'vertex',
    source: 'fallback',
    warnings: [
      `ORB_LIVE_PROVIDER=${env.ORB_LIVE_PROVIDER} is not a recognized provider (expected 'vertex' or 'livekit') — falling back to vertex`,
    ],
  };
}

/**
 * Read LiveKit config out of an env object. Exported so the LiveKit
 * skeleton's interface-conformance tests can construct a client without
 * duplicating the env→config mapping.
 */
export function readLiveKitConfigFromEnv(
  env: UpstreamProviderEnv = process.env as UpstreamProviderEnv,
): LiveKitClientConfig {
  return {
    url: env.LIVEKIT_URL ?? '',
    apiKey: env.LIVEKIT_API_KEY ?? '',
    apiSecret: env.LIVEKIT_API_SECRET ?? '',
  };
}

/**
 * Construct an upstream client for the given selection.
 *
 * Vertex needs no extra config at construction time (it reads OAuth
 * credentials per-`connect()` via the `getAccessToken` callback in
 * `UpstreamConnectOptions`). LiveKit needs URL + credentials at
 * construction time so the skeleton can validate them up front.
 */
export function createUpstreamLiveClient(
  selection: UpstreamProviderSelection,
  env: UpstreamProviderEnv = process.env as UpstreamProviderEnv,
): UpstreamLiveClient {
  switch (selection.provider) {
    case 'vertex':
      return new VertexLiveClient();
    case 'livekit':
      return new LiveKitLiveClient(readLiveKitConfigFromEnv(env));
    default: {
      // Exhaustiveness check — the type system already guarantees this.
      const _never: never = selection.provider;
      throw new Error(`unreachable provider: ${_never}`);
    }
  }
}
