/**
 * VTID-03462 — Watcher Phase 3: the feedback loop.
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454) §3.4.
 *
 * Turns "was this reminder any use?" into a number, and eventually into a
 * mute. Without this, watcher_lessons only ever grows, the injected block
 * fills with things that never mattered, and the worker learns to skim it —
 * at which point the tokens are still spent and the one reminder that would
 * have helped is lost in the pile.
 */

import { getSupabase } from '../../lib/supabase';

const LOG_PREFIX = '[watcher-feedback]';

/**
 * Auto-mute thresholds.
 *
 * A lesson is muted once it has had a real chance to prove itself (shown at
 * least MIN_SHOWN times) and either never correlated with anything, or was
 * shown and ignored repeatedly. MIN_SHOWN is the guard against muting a
 * lesson that simply has not been retrieved yet — "never helped" and "never
 * shown" must not look the same.
 */
export const MUTE_MIN_SHOWN = 20;
export const MUTE_IGNORED_RATIO = 0.8;

export interface FeedbackInput {
  reminder_id: string;
  work_unit_id?: string | null;
  vtid?: string | null;
  stage?: string | null;
  outcome: 'success' | 'failure' | 'unknown';
  repeated_mistake?: boolean;
  note?: string | null;
}

export function parseReminderId(reminderId: string): { kind: 'rule' | 'lesson'; ref: string } | null {
  const idx = reminderId.indexOf(':');
  if (idx <= 0) return null;
  const kind = reminderId.slice(0, idx);
  const ref = reminderId.slice(idx + 1);
  if (!ref) return null;
  if (kind !== 'rule' && kind !== 'lesson') return null;
  return { kind, ref };
}

/** Record that reminders were injected. The denominator for auto-mute. */
export async function recordShown(reminderIds: string[]): Promise<void> {
  const sb = getSupabase();
  if (!sb || reminderIds.length === 0) return;
  const lessonIds = reminderIds
    .map(parseReminderId)
    .filter((p): p is { kind: 'lesson'; ref: string } => p?.kind === 'lesson')
    .map((p) => p.ref);
  if (lessonIds.length === 0) return;
  try {
    // Read-modify-write rather than an atomic increment: PostgREST has no
    // `col = col + 1` without an RPC, and an undercount under concurrency is
    // acceptable here — shown_count only gates a mute threshold, so drifting
    // low just delays a mute rather than causing a wrong one.
    const { data } = await sb
      .from('watcher_lessons')
      .select('id, shown_count')
      .in('id', lessonIds);
    for (const row of (data || []) as Array<{ id: string; shown_count: number }>) {
      await sb
        .from('watcher_lessons')
        .update({ shown_count: (row.shown_count || 0) + 1 })
        .eq('id', row.id);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} recordShown failed:`, err);
  }
}

/**
 * Record one feedback event and apply its consequence.
 *
 * Returns whether the lesson ended up muted, so the caller (and the Command
 * Hub) can surface that rather than having it happen invisibly.
 */
export async function recordFeedback(
  input: FeedbackInput,
): Promise<{ ok: boolean; muted?: boolean; error?: string }> {
  const parsed = parseReminderId(input.reminder_id);
  if (!parsed) return { ok: false, error: 'INVALID_REMINDER_ID' };

  const sb = getSupabase();
  if (!sb) return { ok: false, error: 'SUPABASE_UNAVAILABLE' };

  try {
    const { error: insErr } = await sb.from('watcher_reminder_feedback').insert({
      reminder_id: input.reminder_id,
      kind: parsed.kind,
      work_unit_id: input.work_unit_id ?? null,
      vtid: input.vtid ?? null,
      stage: input.stage ?? null,
      outcome: input.outcome,
      repeated_mistake: !!input.repeated_mistake,
      note: input.note ?? null,
    });
    if (insErr) return { ok: false, error: insErr.message };

    // Rules are authored canon and are never auto-tuned. "Nobody violated
    // this rule recently" is evidence the rule is WORKING, not evidence it
    // should be retired.
    if (parsed.kind === 'rule') return { ok: true, muted: false };

    const { data } = await sb
      .from('watcher_lessons')
      .select('id, confidence, shown_count, helped_count, ignored_count, status')
      .eq('id', parsed.ref)
      .maybeSingle();
    if (!data) return { ok: true, muted: false };

    const row = data as {
      id: string; confidence: number; shown_count: number;
      helped_count: number; ignored_count: number; status: string;
    };

    let confidence = row.confidence ?? 0.5;
    let helped = row.helped_count || 0;
    let ignored = row.ignored_count || 0;

    if (input.repeated_mistake) {
      // Shown, and the mistake happened anyway. The lesson is not necessarily
      // WRONG — more often it is too vague to act on. Either way it has not
      // earned its place in the budget.
      ignored += 1;
      confidence = Math.max(0.05, confidence - 0.15);
    } else if (input.outcome === 'success') {
      helped += 1;
      confidence = Math.min(0.95, confidence + 0.05);
    }

    const shown = row.shown_count || 0;
    const ignoredRatio = shown > 0 ? ignored / shown : 0;
    const shouldMute =
      row.status === 'active' &&
      shown >= MUTE_MIN_SHOWN &&
      (ignoredRatio >= MUTE_IGNORED_RATIO || helped === 0);

    const { error: updErr } = await sb
      .from('watcher_lessons')
      .update({
        confidence,
        helped_count: helped,
        ignored_count: ignored,
        ...(shouldMute ? { status: 'muted' } : {}),
      })
      .eq('id', row.id);
    if (updErr) return { ok: false, error: updErr.message };

    return { ok: true, muted: shouldMute };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} recordFeedback failed:`, message);
    return { ok: false, error: message };
  }
}
