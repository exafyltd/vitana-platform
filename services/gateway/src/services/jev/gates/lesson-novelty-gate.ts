/**
 * VTID-04818: Jev P3 gate F — lesson novelty before a dev_agent_memory write.
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 F, learning loop)
 *
 *   lesson_novelty   (JEV_LESSON_NOVELTY_MODE = off | shadow | enforce)
 *
 * Operator Console turns (VTID-04025) and Dev Autopilot agent runs
 * (VTID-04223) extract up to three lessons each into `dev_agent_memory`
 * (≈ 230 gotchas / conventions / decisions / incidents in the 30 days to
 * 2026-10-01). Nothing checks whether a lesson is already stored, corrects
 * one, or is only true for that run — recall then returns near-copies.
 *
 * Before each extracted lesson is written, the three most similar stored
 * lessons are recalled (the same embedding search the agents read with) and
 * Jev `lesson_novelty` judges the candidate next to them: new and durable?
 * new / duplicate / update / too specific / not a lesson. Never awaited; the
 * write happens exactly as before. A rule is certain at the edges — a stored
 * lesson with similarity ≥ 0.92 is a duplicate, best similarity < 0.75 is
 * new — and agreement is written at once there. Skipping duplicates and
 * superseding updated lessons is enforce, after the data. The weekly
 * root-cause roll-up of the learning loop is a later slice.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const LESSON_NOVELTY_GATE = 'lesson_novelty';
export const DUPLICATE_SIMILARITY = 0.92;
export const NEW_SIMILARITY = 0.75;
const SYSTEM_CALLER = { actor_id: 'dev-agent-memory', system: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LessonCandidate {
  category: string;
  title: string;
  content: string;
}

export interface StoredLesson {
  category: string;
  title: string;
  content: string;
  similarity: number;
  created_at?: string;
}

export type LessonRecall = (query: string) => Promise<{ ok: true; hits: StoredLesson[] } | { ok: false; error: string }>;

export function isLessonNoveltyOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(LESSON_NOVELTY_GATE, env) !== 'off';
}

/** The rule at the edges: 'duplicate' (≥ 0.92), 'new' (< 0.75 or nothing stored), else null. */
export function ruleNovelty(bestSimilarity: number | null): 'duplicate' | 'new' | null {
  if (bestSimilarity === null || bestSimilarity < NEW_SIMILARITY) return 'new';
  if (bestSimilarity >= DUPLICATE_SIMILARITY) return 'duplicate';
  return null;
}

export function lessonRef(threadId: string, c: LessonCandidate): string {
  return `${threadId.slice(0, 80)}:${createHash('sha1').update(`${c.category}\n${c.title}`).digest('hex').slice(0, 12)}`;
}

/** Judge one candidate lesson. Returns the row id or null; never throws. */
export async function runLessonNoveltyCheck(a: {
  threadId: string;
  candidate: LessonCandidate;
  recall: LessonRecall;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  now?: () => number;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(LESSON_NOVELTY_GATE, env);
  if (mode === 'off') return null;
  try {
    const c = a.candidate;
    const rec = await a.recall(`${c.title}\n${c.content}`);
    if (!rec.ok) return null;
    const now = (a.now ?? Date.now)();
    const existing = rec.hits
      .slice()
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, 3)
      .map((h) => ({
        category: String(h.category || 'unknown').slice(0, 40),
        title: String(h.title || '').slice(0, 300) || '(untitled)',
        content: String(h.content || '').slice(0, 600) || '(empty)',
        similarity: Math.max(0, Math.min(1, Number(h.similarity) || 0)),
        age_days: h.created_at ? Math.max(0, Math.round((now - Date.parse(h.created_at)) / DAY_MS)) : 0,
      }));
    const best = existing.length ? existing[0].similarity : null;
    const rule = ruleNovelty(best);
    const r = await decide(
      'lesson_novelty',
      { category: c.category.slice(0, 40), title: c.title.slice(0, 300) || '(untitled)', content: c.content.slice(0, 1500) || '(empty)', existing },
      SYSTEM_CALLER,
      { ...(a.decideOptions || {}), source: `gate:${LESSON_NOVELTY_GATE}`, env },
    );
    const keep = r.ok && r.outcome === 'decided' ? r.verdict.value === true : null;
    const agreed = keep === null || rule === null ? null : keep === (rule === 'new');
    return await recordJevShadowDecision(
      {
        gate: LESSON_NOVELTY_GATE,
        decision: 'lesson_novelty',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_memory_candidate',
        subject_ref: lessonRef(a.threadId, c),
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { new_and_durable: keep, probability: r.answers.new_and_durable?.probability ?? null, kind: r.answers.kind?.value ?? null, rule, best_similarity: best, category: c.category, stored: existing.length }
          : { reason: r.reason, rule, best_similarity: best, category: c.category, stored: existing.length },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'written',
        cost_usd: r.ok ? r.cost_usd : 0,
        agreed,
        outcome: agreed === null ? null : 'compared_with_similarity_rule',
        outcome_at: agreed === null ? null : new Date(now).toISOString(),
      },
      a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${LESSON_NOVELTY_GATE} failed for ${a.threadId}: ${err?.message || err}`);
    return null;
  }
}
