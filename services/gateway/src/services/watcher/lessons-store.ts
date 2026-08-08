/**
 * VTID-03461 — Watcher Phase 2: watcher_lessons / watcher_rules access.
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454).
 *
 * This module replaces the dev_autopilot_prompt_learnings read/write helpers
 * that used to live inline in dev-autopilot-execute.ts and
 * dev-autopilot-planning.ts. Those two files now call in here instead, so
 * there is exactly one place that knows the lesson schema.
 *
 * Every function is best-effort: on any DB problem it returns an empty
 * result rather than throwing. That is not laziness — the Phase 2 migration's
 * deploy-order safety argument depends on it. If a lessons read ever becomes
 * fatal, a migration/deploy window where the table does not yet exist would
 * take planning and execution down with it.
 */

import { getSupabase } from '../../lib/supabase';
import type {
  LessonRow,
  LessonStage,
  LessonPatternType,
  LessonScope,
  RuleRow,
} from './lesson-types';

const LOG_PREFIX = '[watcher-lessons]';

/** Lessons stop being injected once they go stale. */
const LESSON_WINDOW_DAYS = 14;

/**
 * A lesson seen exactly once is a guess, not a pattern — a single flaky CI
 * run should not become permanent doctrine injected into every future prompt.
 * Such lessons are withheld from injection until they either recur (frequency
 * rises) or age past this window without recurring, at which point they are
 * stale anyway and drop out on the window check above.
 */
const SINGLETON_QUARANTINE_DAYS = 7;

/** Cap on retained evidence ids per lesson. Newest win. */
const MAX_EVIDENCE_IDS = 20;

/**
 * Confidence as a function of how often a pattern has recurred.
 *
 * Asymptotic toward 1.0 — a lesson seen 50 times is not 50x more certain than
 * one seen 10 times — and deliberately capped below 1.0 so Phase 3's negative
 * feedback always has somewhere to move it.
 */
export function confidenceForFrequency(frequency: number): number {
  return Math.min(0.95, 0.5 + Math.log10(frequency + 1) * 0.35);
}

/**
 * Write a distilled lesson, maturing it if the same pattern has been seen
 * before.
 *
 * This is a read-then-write rather than a plain PostgREST upsert, and that is
 * load-bearing: `frequency` has to INCREMENT on recurrence, and PostgREST
 * cannot express `frequency = frequency + 1` in an upsert body. The original
 * version here was a plain upsert, which left every lesson permanently at
 * frequency 1 while refreshing `last_seen_at` on each recurrence — and
 * `loadLessons` withholds a frequency-1 lesson until it is older than
 * SINGLETON_QUARANTINE_DAYS. So the more often a pattern actually recurred,
 * the more reliably its quarantine clock got reset, and it could never
 * graduate into injection. A recurring failure was the one thing guaranteed
 * never to be remembered. (VTID-03531)
 *
 * The extra round trip is affordable: distillation runs once per observer
 * tick over the handful of steps newly inserted that tick, not per row.
 */
export async function upsertLesson(input: {
  stage: LessonStage;
  pattern_type: LessonPatternType;
  pattern_key: string;
  scope?: LessonScope;
  lesson: string;
  example_message?: string | null;
  evidence_step_ids?: string[];
  source_finding_id?: string | null;
  source_execution_id?: string | null;
}): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const pattern_key = input.pattern_key.slice(0, 200);
  try {
    const now = new Date().toISOString();

    const { data: existing } = await sb
      .from('watcher_lessons')
      .select('id, frequency, evidence_step_ids')
      .eq('stage', input.stage)
      .eq('pattern_type', input.pattern_type)
      .eq('pattern_key', pattern_key)
      .maybeSingle();

    if (existing) {
      // Increment by the number of steps in THIS batch, not by one.
      //
      // Three CI failures with the same signature really are three
      // occurrences, and frequency is the evidence that a lesson describes a
      // real pattern rather than a one-off — undercounting it keeps genuine
      // patterns in singleton quarantine longer than the data warrants. It
      // also makes a historical backfill correct with no special case: one
      // batch of 50 past failures yields frequency 50, exactly as if they had
      // been observed live.
      const occurrences = Math.max(1, (input.evidence_step_ids ?? []).length);
      const frequency = ((existing.frequency as number) || 1) + occurrences;
      const prior = (existing.evidence_step_ids as string[]) || [];
      // Newest evidence last, de-duplicated, bounded. Unbounded growth would
      // turn a chronically recurring pattern's row into an ever-growing array
      // that every read then has to haul back.
      const merged = [...new Set([...prior, ...(input.evidence_step_ids ?? [])])]
        .slice(-MAX_EVIDENCE_IDS);

      const { error } = await sb
        .from('watcher_lessons')
        .update({
          frequency,
          confidence: confidenceForFrequency(frequency),
          evidence_step_ids: merged,
          last_seen_at: now,
          // The lesson TEXT is refreshed but the example is not: the first
          // example is as representative as the fiftieth, and churning it
          // would make the row look freshly-edited to a human reviewer on
          // every recurrence.
          lesson: input.lesson.slice(0, 500),
        })
        .eq('id', existing.id as string);

      if (error) {
        console.warn(`${LOG_PREFIX} recurrence update failed:`, error.message);
        return false;
      }
      return true;
    }

    const firstSeenCount = Math.max(1, (input.evidence_step_ids ?? []).length);
    const { error } = await sb.from('watcher_lessons').insert({
      stage: input.stage,
      pattern_type: input.pattern_type,
      pattern_key,
      scope: input.scope ?? {},
      lesson: input.lesson.slice(0, 500),
      example_message: (input.example_message || '').slice(0, 500) || null,
      // A pattern that arrives already-recurring (several occurrences in its
      // very first batch — the normal case for a backfill) must not be filed
      // as a singleton, or the quarantine withholds a lesson we already have
      // ample evidence for.
      frequency: firstSeenCount,
      confidence: confidenceForFrequency(firstSeenCount),
      evidence_step_ids: (input.evidence_step_ids ?? []).slice(-MAX_EVIDENCE_IDS),
      source_finding_id: input.source_finding_id ?? null,
      source_execution_id: input.source_execution_id ?? null,
      last_seen_at: now,
    });

    if (error) {
      // A concurrent insert of the same pattern loses the race on the unique
      // index. That is the system working — the winner recorded the lesson —
      // so it is not worth logging as a fault.
      if (error.code === '23505') return true;
      console.warn(`${LOG_PREFIX} insert failed:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`${LOG_PREFIX} upsert threw:`, err);
    return false;
  }
}

/**
 * Bump frequency/confidence when an already-known pattern recurs.
 *
 * Recurrence is the only evidence we have that a lesson describes a real
 * pattern rather than a one-off, so it is the only thing that raises
 * confidence here. Phase 3's feedback loop is what lowers it.
 */
export async function recordRecurrence(lessonId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data } = await sb
      .from('watcher_lessons')
      .select('frequency, confidence')
      .eq('id', lessonId)
      .maybeSingle();
    if (!data) return;
    const frequency = (data.frequency as number) + 1;
    const confidence = confidenceForFrequency(frequency);
    await sb
      .from('watcher_lessons')
      .update({ frequency, confidence, last_seen_at: new Date().toISOString() })
      .eq('id', lessonId);
  } catch (err) {
    console.warn(`${LOG_PREFIX} recurrence failed:`, err);
  }
}

/** Does a lesson's scope match the caller's context? */
export function scopeMatches(scope: LessonScope, ctx: LessonScope): boolean {
  // An empty scope is universal — it applies wherever its stage does.
  const keys = Object.keys(scope || {});
  if (keys.length === 0) return true;
  for (const k of keys) {
    const want = (scope as Record<string, unknown>)[k];
    const have = (ctx as Record<string, unknown>)[k];
    if (want === undefined || want === null) continue;
    // A scoped lesson whose key the caller did not supply must NOT match.
    // Treating "unknown" as "matches" is how a scanner-specific lesson would
    // leak into every unrelated worker-runner prompt.
    if (have === undefined || have === null) return false;
    if (String(want) !== String(have)) return false;
  }
  return true;
}

/**
 * Load candidate lessons for a stage. Scope filtering happens in memory:
 * the row counts here are tiny (tens), and expressing jsonb containment
 * with the partial-match semantics above in PostgREST is not worth the
 * opacity.
 */
export async function loadLessons(
  stage: LessonStage,
  ctx: LessonScope = {},
  limit = 50,
): Promise<LessonRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  try {
    const since = new Date(Date.now() - LESSON_WINDOW_DAYS * 86400_000).toISOString();
    const { data, error } = await sb
      .from('watcher_lessons')
      .select('id, stage, pattern_type, pattern_key, scope, lesson, example_message, mitigation_note, frequency, confidence, status, last_seen_at')
      // 'any' lessons apply at every stage; that is what the value is for.
      .in('stage', [stage, 'any'])
      .eq('status', 'active')
      .gte('last_seen_at', since)
      .order('last_seen_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];

    const quarantineCutoff = Date.now() - SINGLETON_QUARANTINE_DAYS * 86400_000;
    return (data as LessonRow[])
      .filter((l) => scopeMatches(l.scope || {}, ctx))
      .filter((l) => {
        if (l.frequency > 1) return true;
        // Seen once and still fresh → withhold. See SINGLETON_QUARANTINE_DAYS.
        return new Date(l.last_seen_at).getTime() < quarantineCutoff;
      });
  } catch (err) {
    console.warn(`${LOG_PREFIX} load failed:`, err);
    return [];
  }
}

/** Load enabled authored rules for a stage. */
export async function loadRules(stage: LessonStage): Promise<RuleRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('watcher_rules')
      .select('rule_key, source_ref, stage, trigger, reminder, severity, enabled')
      .in('stage', [stage, 'any'])
      .eq('enabled', true);
    if (error || !data) return [];
    return data as RuleRow[];
  } catch (err) {
    console.warn(`${LOG_PREFIX} rules load failed:`, err);
    return [];
  }
}

/**
 * Does an authored rule's declarative trigger fire for this context?
 *
 * Supported keys: steps[], touches[] (globs), services[], actors[].
 * An empty trigger always fires — it means "whenever this stage runs".
 */
export function ruleTriggers(
  trigger: RuleRow['trigger'],
  ctx: { step?: string; touched_paths?: string[]; service?: string; actor?: string },
): boolean {
  const t = trigger || {};
  if (Array.isArray(t.steps) && t.steps.length > 0) {
    if (!ctx.step || !t.steps.includes(ctx.step)) return false;
  }
  if (Array.isArray(t.services) && t.services.length > 0) {
    if (!ctx.service || !t.services.includes(ctx.service)) return false;
  }
  if (Array.isArray(t.actors) && t.actors.length > 0) {
    if (!ctx.actor || !t.actors.includes(ctx.actor)) return false;
  }
  if (Array.isArray(t.touches) && t.touches.length > 0) {
    const paths = ctx.touched_paths || [];
    if (paths.length === 0) return false;
    if (!t.touches.some((glob) => paths.some((p) => globMatches(glob, p)))) return false;
  }
  return true;
}

/**
 * Minimal glob matcher for the `touches` triggers: `**` spans separators,
 * `*` does not. Deliberately small — these globs come from our own seed
 * migration, not from user input, so a full glob engine would be a
 * dependency bought for nothing.
 *
 * Splits on `**` rather than substituting a placeholder for it. The
 * placeholder approach needs a sentinel that cannot occur in the input, and
 * every such sentinel is either a control byte — which makes the source file
 * read as BINARY to grep, diff and review tooling — or something a glob
 * could legitimately contain. This version needs no sentinel at all.
 */
export function globMatches(glob: string, path: string): boolean {
  const escapeSegment = (s: string) =>
    s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  const pattern = glob.split('**').map(escapeSegment).join('.*');
  return new RegExp(`^${pattern}$`).test(path);
}
