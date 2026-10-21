/**
 * VTID-03255 — new-day overview payload (P3).
 *
 * Assembles the data the morning greeting needs: the current snapshot plus the
 * most recent session update ("since we last spoke"). Kept separate from the
 * prompt renderer so the same payload can feed both the spoken greeting and the
 * "Meine Reise" screen banner.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  JourneyFoundationSnapshot,
  JourneySessionUpdateView,
} from './types';
import { buildJourneyFoundationSnapshot } from './journey-foundation-state';

export interface NewDayOverviewPayload {
  snapshot: JourneyFoundationSnapshot;
  last_session_update: JourneySessionUpdateView | null;
}

export async function buildNewDayOverviewPayload(
  client: SupabaseClient,
  userId: string,
): Promise<NewDayOverviewPayload> {
  const snapshot = await buildJourneyFoundationSnapshot(client, userId);
  return {
    snapshot,
    last_session_update: snapshot.recent_session_updates[0] ?? null,
  };
}
