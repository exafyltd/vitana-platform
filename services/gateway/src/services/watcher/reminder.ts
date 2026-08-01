/**
 * VTID-03462 — Watcher Phase 3: reminder retrieval, ranking and budget.
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454) §3.2.
 *
 * =============================================================================
 * The budget is the feature, not a safety valve
 * =============================================================================
 * An unbounded "lessons from prior attempts" block is how prompt sections get
 * skimmed past. Once a model learns that a section is mostly irrelevant, the
 * ONE reminder that mattered is lost with the rest — a worker that ignores the
 * reminder block is strictly worse than one that never had it, because the
 * tokens were still spent and the false confidence is real.
 *
 * So: at most MAX_REMINDERS items and MAX_TOKENS worth of text, ranked, rules
 * first. Anything cut is reported in `truncated` rather than silently dropped,
 * because a caller that believes it saw everything will not go looking.
 *
 * =============================================================================
 * Advisory only
 * =============================================================================
 * Nothing here blocks. `block_candidate` marks a rule that COULD be gated if
 * gating is ever turned on; it is reported at higher rank and nothing more. A
 * blocking watcher that is wrong once gets switched off forever, and then the
 * advisory value is lost too.
 */

import { loadLessons, loadRules, ruleTriggers } from './lessons-store';
import type { LessonRow, LessonScope, LessonStage, RuleRow } from './lesson-types';

/** Hard caps. See the header — these are load-bearing, not tuning knobs. */
export const MAX_REMINDERS = 6;
export const MAX_TOKENS = 800;

/** ~4 chars per token is the usual English approximation; deliberately crude. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ReminderContext {
  stage: LessonStage;
  vtid?: string | null;
  scanner?: string;
  service?: string;
  step?: string;
  actor?: string;
  touched_paths?: string[];
}

export interface Reminder {
  /** Stable id the caller echoes back to /feedback. */
  reminder_id: string;
  kind: 'rule' | 'lesson';
  text: string;
  /** Where the reminder's authority comes from (CLAUDE.md §x, or evidence). */
  source: string;
  severity: 'info' | 'warn' | 'block_candidate';
  score: number;
}

export interface ReminderBundle {
  reminders: Reminder[];
  truncated: { dropped: number; reason?: string };
  /** Reported so a caller can see the budget actually being applied. */
  tokens_used: number;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  block_candidate: 1.0,
  warn: 0.6,
  info: 0.3,
};

/**
 * Recency decay over the lesson window. A lesson last seen today is far more
 * likely to still be true than one from two weeks ago — the codebase moved.
 */
export function recencyScore(lastSeenAt: string, now = Date.now()): number {
  const ageDays = (now - new Date(lastSeenAt).getTime()) / 86400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.max(0, 1 - ageDays / 14);
}

/**
 * Frequency contribution, log-scaled. A lesson seen 50 times is not 50x more
 * important than one seen 5 times, and linear weighting would let one noisy
 * recurring failure monopolise the whole budget.
 */
export function frequencyScore(frequency: number): number {
  return Math.min(1, Math.log10(Math.max(1, frequency) + 1) / 2);
}

export function scoreLesson(l: LessonRow, ctx: ReminderContext, now = Date.now()): number {
  const stageMatch = l.stage === ctx.stage ? 1 : 0.5; // 'any' lessons rank lower
  const scopeMatch = Object.keys(l.scope || {}).length > 0 ? 1 : 0.6;
  return (
    0.35 * stageMatch +
    0.20 * scopeMatch +
    0.20 * recencyScore(l.last_seen_at, now) +
    0.15 * frequencyScore(l.frequency) +
    0.10 * (l.confidence ?? 0.5)
  );
}

/**
 * Authored rules outrank learned lessons by construction: a rule is canon
 * that is true today, a lesson is an inference from past failures. The +1.0
 * base is what guarantees rules occupy the budget first.
 */
export function scoreRule(r: RuleRow): number {
  return 1.0 + (SEVERITY_WEIGHT[r.severity] ?? 0.3);
}

/** Prefer the human-authored text when someone has written one. */
export function lessonText(l: LessonRow): string {
  const note = (l.mitigation_note || '').trim();
  return note || l.lesson;
}

/**
 * Assemble the ranked, budgeted block for a context.
 *
 * Returns an empty bundle rather than throwing on any failure — the callers
 * are prompt builders on the critical path of planning and execution, and the
 * Watcher must never be able to stall them.
 */
export async function buildReminders(ctx: ReminderContext): Promise<ReminderBundle> {
  let rules: RuleRow[] = [];
  let lessons: LessonRow[] = [];
  try {
    const scope: LessonScope = {};
    if (ctx.scanner) scope.scanner = ctx.scanner;
    if (ctx.service) scope.service = ctx.service;
    [rules, lessons] = await Promise.all([
      loadRules(ctx.stage),
      loadLessons(ctx.stage, scope),
    ]);
  } catch {
    return { reminders: [], truncated: { dropped: 0 }, tokens_used: 0 };
  }

  const candidates: Reminder[] = [];

  for (const r of rules) {
    if (!ruleTriggers(r.trigger, {
      step: ctx.step,
      touched_paths: ctx.touched_paths,
      service: ctx.service,
      actor: ctx.actor,
    })) continue;
    candidates.push({
      reminder_id: `rule:${r.rule_key}`,
      kind: 'rule',
      text: r.reminder,
      source: r.source_ref,
      severity: r.severity,
      score: scoreRule(r),
    });
  }

  const now = Date.now();
  for (const l of lessons) {
    candidates.push({
      reminder_id: `lesson:${l.id}`,
      kind: 'lesson',
      text: lessonText(l),
      source: `learned: ${l.pattern_type}/${l.pattern_key} (seen ${l.frequency}x)`,
      severity: 'warn',
      score: scoreLesson(l, ctx, now),
    });
  }

  // Deterministic ordering. Ties broken by reminder_id so the same context
  // yields the same block every time — a reminder set that reshuffles between
  // otherwise-identical calls makes prompt regressions impossible to bisect.
  candidates.sort((a, b) =>
    b.score - a.score || a.reminder_id.localeCompare(b.reminder_id));

  const kept: Reminder[] = [];
  let tokens = 0;
  let dropped = 0;
  let reason: string | undefined;

  for (const c of candidates) {
    if (kept.length >= MAX_REMINDERS) {
      dropped++;
      reason = reason || `capped at ${MAX_REMINDERS} reminders`;
      continue;
    }
    const cost = estimateTokens(c.text);
    if (tokens + cost > MAX_TOKENS) {
      dropped++;
      reason = reason || `capped at ${MAX_TOKENS} tokens`;
      continue;
    }
    kept.push(c);
    tokens += cost;
  }

  return { reminders: kept, truncated: { dropped, reason }, tokens_used: tokens };
}

/**
 * Render the block for prompt injection.
 *
 * Cites each reminder's source. A reminder that reads as the model's own
 * opinion is easy to argue past; "CLAUDE.md §16" is not.
 */
export function renderRemindersBlock(bundle: ReminderBundle): string {
  if (bundle.reminders.length === 0) return '';
  const lines: string[] = [
    '',
    '## Watcher reminders',
    '',
    'Recorded from prior runs and project canon. Advisory, not blocking.',
    '',
  ];
  for (const r of bundle.reminders) {
    const tag = r.severity === 'block_candidate' ? '**[critical]** ' : '';
    lines.push(`- ${tag}${r.text}`);
    lines.push(`  _(${r.source})_`);
  }
  if (bundle.truncated.dropped > 0) {
    // Never let a truncated block read as complete.
    lines.push('');
    lines.push(`_${bundle.truncated.dropped} further reminder(s) withheld — ${bundle.truncated.reason}._`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Resolved feature gate.
 *
 * Reported alongside the raw env var by /health for the reason
 * BOOTSTRAP-ORB-FASTSTART-DRIFT exists: a var being SET does not mean the
 * feature is LIVE, and a whole ORB outage came from assuming otherwise.
 */
export function remindersEnabled(): boolean {
  return (process.env.WATCHER_REMINDERS_ENABLED || '').toLowerCase() === 'true';
}
