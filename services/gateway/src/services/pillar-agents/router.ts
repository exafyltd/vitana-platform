/**
 * Pillar Agent Router (Phase F v1).
 *
 * Single entry point for "ask the right pillar agent". Detects the target
 * pillar from a natural-language question (canonical name OR retired
 * alias OR a few obvious keywords), then dispatches to that agent's
 * `answerQuestion`. Returns null when:
 *
 *   - the question doesn't reference any pillar
 *   - or the matching agent doesn't implement `answerQuestion` yet
 *
 * Callers (ORB tool, future Brain dispatcher) treat null as "fall back
 * to KB search / default response path". Never throws — best-effort.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePillarKey, type PillarKey } from '../../lib/vitana-pillars';
import type { PillarAnswer, PillarAgent } from './types';
import { buildAllAgents } from './orchestrator';

/**
 * Pillar detection keywords (EN + DE, lowercased). The retired aliases
 * (physical/social/environmental/prosperity/nutritional) are routed via
 * resolvePillarKey, so they map silently — caller never sees the retired
 * name. Keywords listed here augment the canonical pillar names with
 * common synonyms voice users actually say.
 */
const PILLAR_KEYWORDS: Record<PillarKey, readonly string[]> = {
  nutrition: ['nutrition', 'nutritional', 'diet', 'food', 'meal', 'eating', 'macros', 'biomarker', 'glucose',
              'ernährung', 'essen', 'mahlzeit', 'diät'],
  hydration: ['hydration', 'water', 'fluid', 'drinking',
              'wasser', 'flüssigkeit', 'trinken'],
  exercise:  ['exercise', 'physical', 'workout', 'movement', 'cardio', 'strength', 'walk', 'walking', 'steps', 'fitness',
              'bewegung', 'sport', 'training', 'gehen', 'laufen'],
  sleep:     ['sleep', 'bedtime', 'rest', 'recovery', 'hrv', 'circadian',
              'schlaf', 'schlafen', 'erholung'],
  mental:    ['mental', 'mindfulness', 'meditation', 'stress', 'mood', 'cognitive', 'social', 'environmental', 'prosperity', 'journaling',
              'psychisch', 'mental', 'achtsamkeit', 'meditation', 'stimmung'],
} as const;

/**
 * Resolve a target pillar from a free-text question. Strategy:
 *   1. Try resolvePillarKey on the whole question (catches "my sleep" via
 *      the canonical/alias map for single-word references).
 *   2. Tokenise + scan keyword buckets, pick highest-scoring pillar.
 *   3. Tie-break by canonical pillar order.
 * Returns undefined when no pillar is mentioned.
 */
export function detectPillarFromQuestion(question: string): PillarKey | undefined {
  if (!question || typeof question !== 'string') return undefined;
  const text = question.toLowerCase();

  // Score each pillar by keyword hits.
  const scores: Record<PillarKey, number> = {
    nutrition: 0, hydration: 0, exercise: 0, sleep: 0, mental: 0,
  };
  for (const [pillar, keywords] of Object.entries(PILLAR_KEYWORDS) as [PillarKey, readonly string[]][]) {
    for (const kw of keywords) {
      // Word-boundary match — avoids false positives like "sleeve" → sleep.
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(text)) scores[pillar] += 1;
    }
  }

  let best: PillarKey | undefined;
  let bestScore = 0;
  for (const pillar of ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'] as PillarKey[]) {
    if (scores[pillar] > bestScore) {
      best = pillar;
      bestScore = scores[pillar];
    }
  }
  if (best) return best;

  // Last resort: maybe the user named a pillar token that resolvePillarKey
  // can disambiguate (handles edge cases like the literal string "physical").
  const tokens = text.split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    const k = resolvePillarKey(tok);
    if (k) return k;
  }
  return undefined;
}

/**
 * Dispatch a question to the appropriate pillar agent. If `pillar` is
 * provided (already-resolved canonical key), bypass detection. Otherwise
 * detect from question text.
 *
 * Returns the PillarAnswer when the matching agent implements
 * `answerQuestion`, else null.
 */
export async function askPillarAgent(
  admin: SupabaseClient,
  userId: string,
  question: string,
  pillar?: PillarKey,
): Promise<PillarAnswer | null> {
  const target = pillar ?? detectPillarFromQuestion(question);
  if (!target) return null;

  const agents: PillarAgent[] = buildAllAgents(admin);
  const agent = agents.find(a => a.pillar === target);
  if (!agent || !agent.answerQuestion) return null;

  try {
    return await agent.answerQuestion(userId, question);
  } catch (err: any) {
    console.warn(`[pillar-agent-router] ${target} agent answerQuestion failed: ${err?.message}`);
    return null;
  }
}
