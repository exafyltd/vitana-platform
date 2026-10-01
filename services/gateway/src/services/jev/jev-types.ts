/**
 * VTID-04473: Jev (TypeSafe "System One") wire types and answer validation.
 *
 * Contract verified against https://docs.typesafe.ai/api (2026-09-24):
 *   POST /v1/systemone  { model, state, questions } -> { model, answers, usage }
 *   question types: noul (yes/no), choice (criteria map, <=255), score (2-10 levels)
 *
 * Every answer is validated against the question that produced it before any
 * caller sees it. A malformed answer is treated exactly like a failed call:
 * the decision falls back (docs/JEV-INTEGRATION-PLAN.md §3.1).
 */

export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option key -> description of when to pick it */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered level descriptions, lowest first */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  legend?: unknown;
  probabilities?: Record<string, number> | number[];
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  answers: JevAnswers;
  usage: JevUsage;
}

/** Throws with a precise message when a question set violates the API limits. */
export function assertValidQuestions(questions: JevQuestions): void {
  const names = Object.keys(questions);
  if (names.length === 0) throw new Error('jev: at least one question is required');
  for (const name of names) {
    const q = questions[name];
    if (!q || typeof q.instructions !== 'string' || !q.instructions.trim()) {
      throw new Error(`jev: question "${name}" has no instructions`);
    }
    if (q.type === 'choice') {
      const opts = Object.keys(q.criteria || {});
      if (opts.length < 2) throw new Error(`jev: choice "${name}" needs at least 2 options`);
      if (opts.length > JEV_MAX_CHOICE_OPTIONS) {
        throw new Error(`jev: choice "${name}" has ${opts.length} options (max ${JEV_MAX_CHOICE_OPTIONS})`);
      }
    } else if (q.type === 'score') {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < JEV_MIN_SCORE_LEVELS || n > JEV_MAX_SCORE_LEVELS) {
        throw new Error(`jev: score "${name}" needs ${JEV_MIN_SCORE_LEVELS}-${JEV_MAX_SCORE_LEVELS} levels (got ${n})`);
      }
    } else if (q.type !== 'noul') {
      throw new Error(`jev: question "${name}" has unknown type`);
    }
  }
}

function isProbability(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Validates every answer against its question. Returns the list of problems;
 * an empty list means the answer set is safe to use.
 */
export function validateAnswers(questions: JevQuestions, answers: unknown): string[] {
  const problems: string[] = [];
  if (!answers || typeof answers !== 'object') return ['answers missing'];
  const a = answers as Record<string, any>;
  for (const [name, q] of Object.entries(questions)) {
    const ans = a[name];
    if (!ans || typeof ans !== 'object') {
      problems.push(`${name}: no answer`);
      continue;
    }
    if (q.type === 'noul') {
      if (!isProbability(ans.noul)) problems.push(`${name}: noul not in [0,1]`);
    } else if (q.type === 'choice') {
      if (typeof ans.choice !== 'string' || !(ans.choice in q.criteria)) {
        problems.push(`${name}: choice "${String(ans.choice)}" is not a declared option`);
      }
      if (!isProbability(ans.confidence)) problems.push(`${name}: confidence not in [0,1]`);
    } else if (q.type === 'score') {
      // The public docs call `score` a "weighted value" without fixing its
      // scale (0-based level, 1-based level or 0..1). Accept 0..levels and
      // read the level through scoreLevel(), which prefers the per-level
      // probabilities. Phase 0 pins the real scale against the live API.
      const levels = q.criteria.length;
      if (typeof ans.score !== 'number' || !Number.isFinite(ans.score) || ans.score < 0 || ans.score > levels) {
        problems.push(`${name}: score outside 0..${levels}`);
      }
      if (!isProbability(ans.confidence)) problems.push(`${name}: confidence not in [0,1]`);
    }
  }
  return problems;
}

/** Probability that a choice answer's chosen option is right. */
export function choiceProbability(ans: JevChoiceAnswer): number {
  const p = ans.probabilities?.[ans.choice];
  return isProbability(p) ? p : ans.confidence;
}

/**
 * The 0-based level a score answer lands on. Uses the per-level probability
 * distribution when the response carries one (argmax), otherwise rounds the
 * weighted score, clamped to the level range.
 */
export function scoreLevel(ans: JevScoreAnswer, levels: number): number {
  const probs = ans.probabilities;
  const list: number[] | null = Array.isArray(probs)
    ? probs
    : probs && typeof probs === 'object'
      ? Object.keys(probs).sort((a, b) => Number(a) - Number(b)).map((k) => (probs as Record<string, number>)[k])
      : null;
  if (list && list.length === levels && list.every(isProbability)) {
    let best = 0;
    for (let i = 1; i < list.length; i++) if (list[i] > list[best]) best = i;
    return best;
  }
  return Math.max(0, Math.min(levels - 1, Math.round(ans.score)));
}
