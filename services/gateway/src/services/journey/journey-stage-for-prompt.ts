/**
 * BOOTSTRAP-DAY-COUNTER-DRIFT — canonical "journey stage for prompt" reader,
 * shared by the live-voice calendar-awareness injection (routes/orb-live.ts)
 * and the text-conversation context pack (services/context-pack-builder.ts).
 *
 * Both call sites used to call journey-calendar-mapper.getJourneyStage()
 * with the WRONG date argument (`new Date()` / the conversation's own start
 * timestamp, instead of the user's registration date), so
 * `Date.now() - Date.now()` always floored to 0 and every session told the
 * LLM "Journey: Day 0 of 90" regardless of the user's real tenure. This
 * wraps the canonical getJourneyState() (the same source /api/v1/my-journey
 * and the ORB greeting use) and maps it to the { day_number, total_days,
 * wave_name } shape both call sites already expect, so day counts injected
 * mid-conversation can never drift from what the greeting and the My
 * Journey screen say.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getJourneyState } from './user-journey-service';

export interface JourneyStageForPrompt {
  day_number: number;
  total_days: number;
  wave_name: string;
}

export async function getJourneyStageForPrompt(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyStageForPrompt | null> {
  const state = await getJourneyState(client, userId);
  if (!state) return null;
  return {
    day_number: state.day_in_journey,
    total_days: state.total_days,
    wave_name: state.current_wave?.name ?? 'Discovery',
  };
}
