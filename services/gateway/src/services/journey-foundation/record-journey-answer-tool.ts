/**
 * VTID-03255 — the `record_journey_answer` voice tool handler.
 *
 * Registered in ORB_TOOL_REGISTRY (orb-tools-shared.ts) so BOTH the Vertex and
 * LiveKit pipelines reach the identical write+delta path, and so it is also
 * callable over POST /api/v1/orb/tool. Every user answer flows through here →
 * journey-foundation-delta writes the real fact, re-verifies, and returns the
 * next move. The tool's text IS the next sentence Vitana should speak.
 *
 * Type-only imports of the Orb tool contract avoid a runtime require cycle with
 * the (large) orb-tools-shared module that registers this handler.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OrbToolArgs,
  OrbToolIdentity,
  OrbToolResult,
} from '../orb-tools-shared';
import { applyJourneyAnswerWithVoice, type JourneyAnswerInput } from './journey-foundation-delta';

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  return String(v);
}
function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function tool_record_journey_answer(
  args: OrbToolArgs,
  identity: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!identity.user_id) {
    return { ok: false, error: 'record_journey_answer requires an authenticated user.' };
  }
  const step = asString((args as any).step)?.trim();
  if (!step) {
    return { ok: false, error: 'record_journey_answer requires a `step`.' };
  }

  const teachMode = (args as any).teach_mode === true || (args as any).teachMode === true;
  const input: JourneyAnswerInput = {
    step,
    value: asString((args as any).value),
    category: asString((args as any).category) ?? null,
    target_value: asNumber((args as any).target_value),
    target_unit: asString((args as any).target_unit) ?? null,
    target_date: asString((args as any).target_date) ?? null,
    starting_value: asNumber((args as any).starting_value),
    acknowledged: (args as any).acknowledged !== false,
    // VTID-03270 — propagate so applyJourneyAnswer skips DATA writes in teach mode.
    teachMode,
  };

  try {
    const delta = await applyJourneyAnswerWithVoice(sb, identity.user_id, input, { teachMode });
    // Full-success shape only — no degraded/partial flags (Gemini Live reads
    // those as failure). The screen reads `result` to refresh + navigate.
    return {
      ok: true,
      text:
        delta.next_line ??
        delta.screen_message ??
        'Saved — your journey is updated.',
      result: {
        completed_step: delta.completed_step,
        verified_status: delta.verified_status,
        next_step: delta.next_step,
        navigation_directive: delta.navigation_directive,
        screen_message: delta.screen_message,
        changed_fields: delta.changed_fields,
      },
    };
  } catch (err: any) {
    return { ok: false, error: `record_journey_answer failed: ${err?.message ?? 'unknown'}` };
  }
}
