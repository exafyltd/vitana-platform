/**
 * VTID-03068 (B0d-real Xk) — Cross-session dedupe via user_assistant_state.
 *
 * The agent-side in-process dedupe (session.py recent-3 set, VTID-03064)
 * only protects against re-firing within a single LiveKit session. The
 * REAL nag is "every time I tap ORB I hear the same reminder again
 * because the reminder is still pending." That's a cross-session
 * problem — the dedupe state has to live in the DB.
 *
 * Strategy: one `user_assistant_state` row per dedupe-key sighting.
 *   signal_name: `next_action_dedupe:<dedupe_key>`
 *   value:       { source, surface, shown_at }
 *   last_seen_at: NOW() on each sighting
 *
 * A candidate is `seen recently` when a matching row exists with
 * last_seen_at >= NOW() - <window>. The default window is 4 hours —
 * long enough to span a "morning + evening orb tap" pattern, short
 * enough to let the candidate fire again the next day.
 *
 * Failure mode: a DB outage MUST NOT silence the orb. Read failures
 * default to "not seen recently" (fail-open). Write failures are
 * fire-and-forget. The user-visible behavior degrades to per-session
 * dedupe only — never to silence.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Default look-back window. Keep at 4h so a morning + evening orb
 *  tap doesn't get the same nudge twice, but the next day is fresh. */
export const DEFAULT_DEDUPE_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Signal-name prefix for the dedupe rows. */
export const DEDUPE_SIGNAL_PREFIX = 'next_action_dedupe:';

export function buildDedupeSignalName(dedupeKey: string): string {
  return DEDUPE_SIGNAL_PREFIX + dedupeKey;
}

export interface DedupeStoreInputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
}

export interface RecordDedupeInputs extends DedupeStoreInputs {
  dedupeKey: string;
  source: string;
  surface: 'orb_wake' | 'orb_turn_end';
}

export interface IsSeenRecentlyInputs extends DedupeStoreInputs {
  dedupeKey: string;
  windowMs?: number;
  nowIso?: string;
}

/**
 * Check whether this dedupe_key was already shown to this user within
 * the look-back window. Returns false on any failure (fail-open —
 * never silence the orb).
 */
export async function isSeenRecently(inputs: IsSeenRecentlyInputs): Promise<boolean> {
  const windowMs = inputs.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  const cutoffIso = new Date(Date.parse(nowIso) - windowMs).toISOString();
  try {
    const { data, error } = await inputs.supabase
      .from('user_assistant_state')
      .select('last_seen_at')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId)
      .eq('signal_name', buildDedupeSignalName(inputs.dedupeKey))
      .gte('last_seen_at', cutoffIso)
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Record a dedupe-key sighting. Upserts the row (same key → bump
 * last_seen_at + increment count). Fire-and-forget — caller does not
 * await for the voice path.
 */
export async function recordDedupeSighting(
  inputs: RecordDedupeInputs,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const nowIso = new Date().toISOString();
    const row = {
      tenant_id: inputs.tenantId,
      user_id: inputs.userId,
      signal_name: buildDedupeSignalName(inputs.dedupeKey),
      value: {
        source: inputs.source,
        surface: inputs.surface,
        shown_at: nowIso,
      },
      // count + last_seen_at are managed via the update trigger when
      // present, but supabase's upsert needs us to set them explicitly
      // so the row reflects "seen N times, most recently at <iso>".
      last_seen_at: nowIso,
    };
    const { error } = await inputs.supabase
      .from('user_assistant_state')
      .upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
