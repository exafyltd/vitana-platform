/**
 * VTID-03255 — session-end summary writer (P3).
 *
 * Called fire-and-forget when a voice session ends. Builds the current
 * snapshot, diffs the done-set against the previous session update to find what
 * was newly completed THIS session, and writes a journey_session_updates row.
 * The most recent row feeds the "Seit dem letzten Gespräch erledigt: …" line on
 * the next "Meine Reise" open and the morning greeting.
 *
 * No logic lives in orb-live.ts — handleLiveSessionStop just calls this.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildJourneyFoundationSnapshot } from './journey-foundation-state';
import { getStepDef } from './foundation-steps';

function doneKeys(steps: { key: string; status: string }[]): string[] {
  return steps.filter((s) => s.status === 'done' || s.status === 'active').map((s) => s.key);
}

export async function recordJourneySessionSummary(
  client: SupabaseClient,
  userId: string,
  sessionId: string | null,
): Promise<void> {
  try {
    const snapshot = await buildJourneyFoundationSnapshot(client, userId);
    const doneNow = doneKeys(snapshot.foundation_steps);

    // Diff against the last session update to isolate "newly completed".
    const { data: last } = await client
      .from('journey_session_updates')
      .select('completed_steps')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const previouslyDone = new Set<string>(
      ((last?.completed_steps as string[] | undefined) ?? []),
    );
    const newlyCompleted = doneNow.filter((k) => !previouslyDone.has(k));

    // Nothing changed and we already have a baseline row → skip the noise.
    if (newlyCompleted.length === 0 && last) return;

    const titles = newlyCompleted.map((k) => getStepDef(k)?.title ?? k);
    const summary =
      titles.length > 0
        ? `Completed: ${titles.join(', ')}.`
        : 'Session started — journey set up.';

    await client.from('journey_session_updates').insert({
      user_id: userId,
      session_id: sessionId,
      completed_steps: newlyCompleted.length > 0 ? newlyCompleted : doneNow,
      next_step: snapshot.current_next_step?.key ?? null,
      summary,
    });
  } catch (err: any) {
    // Fire-and-forget: never let summary writing affect session teardown.
    console.error(`[VTID-03255] recordJourneySessionSummary failed: ${err?.message}`);
  }
}
