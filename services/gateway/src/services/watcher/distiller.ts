/**
 * VTID-03461 — Watcher Phase 2: the distiller.
 *
 * Turns failed watcher_steps into watcher_lessons. Pure derivation functions
 * here; the store writes live in lessons-store.ts.
 *
 * Rule-based first, deliberately. The old prompt-learnings loop already
 * normalized tsc/jest/parse failures with plain regexes and that worked — an
 * LLM is not needed to notice that TS2307 is TS2307. Reserve the model for
 * narrative failures (CI logs, review prose) where there is no signature to
 * extract, which is Phase 3+ work.
 *
 * The hard requirement on every derivation below: SAME INPUT → SAME KEY.
 * pattern_key is the dedupe identity, so anything volatile in it (a line
 * number, a temp path, a run id, a duration) fragments one recurring problem
 * into dozens of one-off lessons that then all sit in singleton quarantine
 * and never get injected. Normalizing volatility out is the whole job.
 */

import type { LessonPatternType, LessonScope, LessonStage } from './lesson-types';
import type { WatcherStep } from './types';

export interface DistilledLesson {
  stage: LessonStage;
  pattern_type: LessonPatternType;
  pattern_key: string;
  scope: LessonScope;
  lesson: string;
  example_message: string;
  evidence_step_ids: string[];
}

/** watcher_steps.step → the lesson stage it belongs to. */
const STEP_TO_STAGE: Record<string, LessonStage> = {
  planned: 'planning',
  queued: 'execute',
  running: 'execute',
  validated: 'validate',
  pr_opened: 'execute',
  ci: 'ci',
  merged: 'merge',
  deploying: 'deploy',
  verified: 'verify',
  failed: 'execute',
  reverted: 'deploy',
  escalated: 'execute',
  completed: 'execute',
  terminalized: 'verify',
  allocated: 'planning',
  doc_updated: 'verify',
};

const STEP_TO_PATTERN_TYPE: Record<string, LessonPatternType> = {
  ci: 'ci_failure',
  deploying: 'deploy_failure',
  merged: 'ci_failure',
  verified: 'verification_failure',
  validated: 'validation_other',
  reverted: 'deploy_failure',
  escalated: 'governance_violation',
};

/**
 * Strip the parts of a message that differ between two occurrences of the
 * same underlying problem. Order matters: longer/more specific patterns are
 * replaced before shorter ones so a UUID is not first chewed up by the
 * hex-number rule.
 */
export function normalizeMessage(raw: string): string {
  return (raw || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{40}\b/gi, '<sha>')
    .replace(/\b[0-9a-f]{7,12}\b/gi, '<sha>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/\b\d+(\.\d+)?(ms|s|m)\b/gi, '<duration>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a stable signature from a failure message.
 *
 * The specific extractors mirror the ones the old prompt-learnings loop used
 * (TS codes, jest expectation shape, missing-module), because those were
 * already proven against real autopilot output.
 */
export function derivePatternKey(step: WatcherStep): string {
  const ev = step.evidence || {};
  const raw = String(
    (ev.message as string) ||
    (ev.error as string) ||
    (ev.example_message as string) ||
    (ev.failure_stage as string) ||
    step.step,
  );

  // TypeScript: the error code IS the signature.
  const ts = /\bTS(\d{4,5})\b/.exec(raw);
  if (ts) {
    const missing = /cannot find module|could not find a declaration/i.test(raw);
    return `TS${ts[1]}:${missing ? 'cannot-find-module' : 'type-error'}`;
  }

  // Jest: the matcher, not the values it compared.
  const jest = /expect\((?:received|.+?)\)\.(\w+)/.exec(raw);
  if (jest) return `jest:${jest[1]}`;

  if (/heap out of memory|JavaScript heap/i.test(raw)) return 'node:oom';
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) return 'net:unreachable';
  if (/permission denied|EACCES|403/i.test(raw)) return 'auth:denied';
  if (/relation .* does not exist|column .* does not exist/i.test(raw)) return 'db:missing-relation';

  const stage = String(ev.failure_stage || '');
  if (stage) return `${step.step}:${stage}`;

  // Fall back to a truncated normalized message. Truncation is what keeps a
  // 4KB stack trace from becoming a unique key per occurrence.
  const norm = normalizeMessage(raw).slice(0, 120);
  return `${step.step}:${norm || 'unknown'}`;
}

/** Human-readable imperative text. This is what actually gets injected. */
export function deriveLessonText(step: WatcherStep, patternKey: string): string {
  const ev = step.evidence || {};
  const where = (ev.service as string) || (ev.topic as string) || step.source;
  switch (patternKey) {
    case 'node:oom':
      return 'A previous attempt ran the Node process out of heap. Prefer streaming/batching over loading whole result sets.';
    case 'net:unreachable':
      return `A previous attempt failed on an unreachable dependency (${where}). Check the endpoint is resolvable from this environment before assuming a code fault.`;
    case 'auth:denied':
      return `A previous attempt was denied by auth/permissions at ${where}. Confirm credentials and role scope before retrying.`;
    case 'db:missing-relation':
      return 'A previous attempt referenced a table/column that does not exist. Check DATABASE_SCHEMA.md and whether the migration has actually been dispatched.';
    default:
      break;
  }
  if (patternKey.startsWith('TS')) {
    return patternKey.endsWith('cannot-find-module')
      ? `A previous attempt imported a module that does not resolve (${patternKey}). Verify the relative-import depth and that the file exists.`
      : `A previous attempt failed to typecheck (${patternKey}). Run tsc before proposing the change as complete.`;
  }
  if (patternKey.startsWith('jest:')) {
    return `A previous attempt failed a jest assertion (${patternKey}). Run the affected suite before claiming success.`;
  }
  return `A previous attempt failed at step '${step.step}' (${patternKey}). Check that path before repeating it.`;
}

/**
 * Distil one failed step. Returns null when the step is not a failure or is
 * not a step class we learn from.
 *
 * Non-failures are excluded on purpose: a successful step tells you what
 * worked once, not what to avoid, and injecting "this worked before" is how
 * you build a prompt that argues for cargo-culting.
 */
export function distilStep(step: WatcherStep & { id?: string }): DistilledLesson | null {
  if (step.outcome !== 'failure') return null;

  const stage = STEP_TO_STAGE[step.step];
  if (!stage) return null;

  const pattern_type = STEP_TO_PATTERN_TYPE[step.step] || 'validation_other';
  const pattern_key = derivePatternKey(step);

  const scope: LessonScope = {};
  const ev = step.evidence || {};
  if (ev.scanner) scope.scanner = String(ev.scanner);

  // `evidence.service` is deliberately NOT copied into the scope — VTID-03534.
  //
  // scope is a RETRIEVAL filter, and scopeMatches() refuses a scoped lesson
  // whenever the caller does not supply that key (correctly — otherwise a
  // scanner-specific lesson leaks into every unrelated prompt). But
  // evidence.service is the name of the service that EMITTED the event, which
  // is provenance, not a caller context. The two are different things, and
  // conflating them made every learned lesson unreachable by all three of its
  // consumers:
  //
  //   planner        passes stage + scanner, never service  -> no match
  //   executor       passes stage + scanner, never service  -> no match
  //   worker-runner  passes service = its DOMAIN ('backend') while the lesson
  //                  carried the emitter name ('worker-backend')  -> no match
  //
  // Measured on production data after the VTID-03531 backfill: 34 lessons
  // stored, 25 injectable by frequency, and 0 reachable by any real caller.
  // The memory existed and nothing could read it — the same shape as the bug
  // VTID-03531 fixed one layer down.
  //
  // The emitting service is not lost: it stays in the step's evidence and in
  // the lesson's pattern_key/example_message, where it belongs as provenance.
  // Leaving scope empty makes the lesson universal within its stage, which is
  // the correct default — "a previous attempt failed to typecheck" is worth
  // knowing regardless of which service emitted it.

  const raw = String((ev.message as string) || (ev.error as string) || '');

  return {
    stage,
    pattern_type,
    pattern_key,
    scope,
    lesson: deriveLessonText(step, pattern_key),
    example_message: raw.slice(0, 500),
    evidence_step_ids: step.id ? [step.id] : [],
  };
}

/**
 * Distil a batch, merging duplicates so one tick's worth of the same failure
 * becomes one lesson carrying all its evidence rather than N competing rows.
 */
export function distilBatch(steps: Array<WatcherStep & { id?: string }>): DistilledLesson[] {
  const byKey = new Map<string, DistilledLesson>();
  for (const s of steps) {
    const d = distilStep(s);
    if (!d) continue;
    const key = `${d.stage}|${d.pattern_type}|${d.pattern_key}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.evidence_step_ids.push(...d.evidence_step_ids);
      // Keep the first example — later ones are the same class by
      // construction, and churning the example on every batch would make the
      // row look freshly-changed to a human reviewer for no reason.
    } else {
      byKey.set(key, d);
    }
  }
  return [...byKey.values()];
}
