/**
 * DEV-COMHU-0503 — ORB Recovery 2+3: typed read/write helper for the shared
 * cross-transport `orb_session_state` table (see migration
 * 20260606000000_DEV_COMHU_0503_orb_session_state.sql).
 *
 * Used by:
 *   - ORB-2+3: 'continuity' — conversation_id + compact transcript + last-turn
 *     / last-greeting timestamps, so close+reopen within the TTL resumes
 *     instead of looking "first-time".
 *   - ORB-4:   'audio_ready_ack' — client audio-pipeline-ready signal.
 *   - ORB-5:   'pending_cta'     — the executable autopilot CTA awaiting "yes".
 *
 * All reads fail-open (return null on any error) — session state is an
 * optimization, never a hard dependency. Writes never throw.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type OrbSessionStateKey =
  | 'continuity'
  | 'audio_ready_ack'
  | 'pending_cta'
  // VTID-03301 — rolling list of recently-served opener dedupe keys
  // (most-recent first), used to rotate the wake-brief opener across sessions
  // so users don't hear the same "complete your profile" line every time.
  | 'recent_openers';

export interface OrbSessionStateRecord<T = unknown> {
  value: T;
  expiresAtMs: number;
}

const TABLE = 'orb_session_state';

/** Read a key for a user. Returns null when absent, expired, or on any error. */
export async function readOrbSessionState<T = unknown>(
  supabase: SupabaseClient,
  userId: string,
  key: OrbSessionStateKey,
  nowMs: number = Date.now(),
): Promise<OrbSessionStateRecord<T> | null> {
  if (!userId || !key) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('value, expires_at')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    const expiresAtMs = Date.parse((data as { expires_at: string }).expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null; // expired
    return { value: (data as { value: T }).value, expiresAtMs };
  } catch {
    return null;
  }
}

/** Upsert a key with a TTL (minutes). Never throws; returns ok=false on error. */
export async function writeOrbSessionState(
  supabase: SupabaseClient,
  userId: string,
  key: OrbSessionStateKey,
  value: unknown,
  ttlMinutes: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  if (!userId || !key) return { ok: false, reason: 'missing_identity_or_key' };
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 15;
  const expiresIso = new Date(nowMs + ttl * 60_000).toISOString();
  const updatedIso = new Date(nowMs).toISOString();
  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: userId, key, value, expires_at: expiresIso, updated_at: updatedIso },
        { onConflict: 'user_id,key' },
      );
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Delete a key (intentional forget — logout / account switch / reset). */
export async function clearOrbSessionState(
  supabase: SupabaseClient,
  userId: string,
  key: OrbSessionStateKey,
): Promise<{ ok: boolean; reason?: string }> {
  if (!userId || !key) return { ok: false, reason: 'missing_identity_or_key' };
  try {
    const { error } = await supabase.from(TABLE).delete().eq('user_id', userId).eq('key', key);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Continuity value shape (ORB-2+3) — what _persistContinuity stores.
// ---------------------------------------------------------------------------

export interface OrbContinuityValue {
  conversation_id: string | null;
  transcript_history: Array<{ role: 'user' | 'assistant'; text: string }>;
  last_turn_at: string | null;
  last_greeting_at: string | null;
  reason: 'hide' | 'connection' | 'reconnect' | string;
}

/** Default TTLs (minutes) by close reason — short-lived continuity. */
export const CONTINUITY_TTL_MINUTES = { hide: 15, disconnect: 5 } as const;
