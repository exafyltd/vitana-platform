/**
 * VTID-04668 (P2 of docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md):
 * evidence-based priority for DEVELOPER recommendations
 * (autopilot_recommendations rows with user_id IS NULL). Community rows are
 * out of scope and are never scored here.
 *
 * Until now impact_score / effort_score were constants per source (plan §1):
 * "Impact 6/10" meant "the scanner called it medium", nothing ranked across
 * sources, and nothing estimated cost or the chance of success. This module
 * is PURE: it turns a recommendation row plus a scoring context (breaker
 * stats, cost medians, optional code-index lookup) into components, a
 * priority and a legacy impact/effort mapping. The I/O lives in
 * scoring-service.ts.
 *
 *   priority = value × confidence × success_odds / max(expected_cost_usd, COST_FLOOR_USD)
 *
 * A card is shown only when passesQualityFloor(): confidence ≥ 0.6 and, for
 * executable types, success_odds ≥ 0.3 (both env-overridable).
 */
import { breakerKeyFor, type LoadedBreakers } from '../dev-autopilot-scanner-breaker';
import { isExecutableSourceType } from '../autopilot-executable-source-types';

export const QUALITY_VERSION = 1;

// ---------------------------------------------------------------------------
// Weight tables (documented; every number that moves a score is here)
// ---------------------------------------------------------------------------

/** Who is affected when the problem is real. */
export const AUDIENCE_WEIGHTS = { members: 1.0, operators: 0.6, ci_only: 0.3 } as const;
export type Audience = keyof typeof AUDIENCE_WEIGHTS;

/**
 * Audience per source_type (system rows) and per dev_autopilot signal_type.
 *   members   — a member-facing path breaks or leaks (runtime errors,
 *               auth / RLS / secrets, schema drift, voice, member behaviour).
 *   operators — the platform team feels it (config, tests, stale flags,
 *               CVEs, PR-time companion changes, stalled VTIDs).
 *   ci_only   — code hygiene nobody outside CI notices (todo, dead code,
 *               duplication, docs, large files, complexity).
 */
export const SOURCE_AUDIENCE: Readonly<Record<string, Audience>> = {
  oasis: 'members',
  behavior: 'members',
  health: 'operators',
  roadmap: 'operators',
  dev_autopilot_impact: 'operators',
  'missing-test-scanner': 'operators',
  'test-contract-failure-scanner': 'operators',
  codebase: 'ci_only',
  llm: 'operators',
};
export const SIGNAL_AUDIENCE: Readonly<Record<string, Audience>> = {
  missing_auth: 'members',
  secret_exposure: 'members',
  rls_gap: 'members',
  schema_drift: 'members',
  voice_health: 'members',
  product_gap: 'members',
  safety_gap: 'operators',
  missing_tests: 'operators',
  stale_flag: 'operators',
  cve: 'operators',
  todo: 'ci_only',
  dead_code: 'ci_only',
  unused_dep: 'ci_only',
  duplication: 'ci_only',
  missing_docs: 'ci_only',
  large_file: 'ci_only',
  circular_dep: 'ci_only',
  cognitive_complexity: 'ci_only',
};
/** Unknown source/signal: operators (neither the best nor the worst case). */
export const DEFAULT_AUDIENCE: Audience = 'operators';

/** How badly: scanner severity / impact severity / risk class. */
export const SEVERITY_WEIGHTS: Readonly<Record<string, number>> = {
  critical: 1.0,
  blocker: 1.0,
  high: 0.85,
  warning: 0.6,
  medium: 0.6,
  low: 0.35,
  info: 0.2,
};

/** value = audience·0.40 + severity·0.35 + frequency·0.25, then × trend. */
export const VALUE_MIX = { audience: 0.4, severity: 0.35, frequency: 0.25 } as const;

/** Trend by days since the signal was last seen. */
export const TREND_STEPS: ReadonlyArray<{ max_days: number; factor: number; label: string }> = [
  { max_days: 3, factor: 1.0, label: 'active (seen in the last 3 days)' },
  { max_days: 14, factor: 0.8, label: 'cooling (last seen 4–14 days ago)' },
  { max_days: Infinity, factor: 0.5, label: 'stale (not seen for over 14 days)' },
];

/** Confidence contributions (start at CONFIDENCE_BASE, clamp to 0..1). */
export const CONFIDENCE_WEIGHTS = {
  base: 0.3,
  concrete_file: 0.2,
  file_in_index: 0.1,
  file_missing_from_index: -0.3,
  events_10_plus: 0.15,
  events_3_plus: 0.08,
  reproduced: 0.15, // seen_count ≥ 2
  scanner_id: 0.1,
  source_ref: 0.1,
} as const;

/** Laplace-smoothed success odds: (successes + 1) / (samples + 2); no history = 0.5. */
export const SUCCESS_ODDS_NO_HISTORY = 0.5;
/**
 * Non-executable types (oasis, roadmap, behavior, health, …) have no
 * executor, so they have no execution history. Fixed prior: plan §2 shows
 * 0 shipped from these sources all time, so it sits at the floor value, not
 * above it.
 */
export const NON_EXECUTABLE_SUCCESS_PRIOR = 0.3;

/** Cost prior when a scanner has no recorded agent runs (or is non-executable). */
export const DEFAULT_EXPECTED_COST_USD = 1.0;
export const DEFAULT_EXPECTED_INPUT_TOKENS = 1_000_000;
/** priority never divides by less than this. */
export const COST_FLOOR_USD = 0.05;
/** effort_score reaches 10 at this expected cost. */
export const EFFORT_COST_CEILING_USD = 3;

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_MIN_SUCCESS_ODDS = 0.3;

function unitNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export interface QualityFloor { min_confidence: number; min_success_odds: number }

/** AUTOPILOT_QUALITY_MIN_CONFIDENCE / AUTOPILOT_QUALITY_MIN_SUCCESS_ODDS. */
export function resolveQualityFloor(env: NodeJS.ProcessEnv = process.env): QualityFloor {
  return {
    min_confidence: unitNum(env.AUTOPILOT_QUALITY_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE),
    min_success_odds: unitNum(env.AUTOPILOT_QUALITY_MIN_SUCCESS_ODDS, DEFAULT_MIN_SUCCESS_ODDS),
  };
}

export interface QualityComponents {
  confidence: number;
  success_odds: number;
  executable: boolean;
}

/** confidence ≥ floor and (non-executable or success_odds ≥ floor). */
export function passesQualityFloor(q: QualityComponents | null | undefined, floor: QualityFloor = resolveQualityFloor()): boolean {
  if (!q) return false;
  if (!(Number(q.confidence) >= floor.min_confidence)) return false;
  return q.executable === false || Number(q.success_odds) >= floor.min_success_odds;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PriorityRow {
  id?: string;
  source_type?: string | null;
  user_id?: string | null;
  risk_class?: string | null;
  risk_level?: string | null;
  impact_score?: number | null;
  effort_score?: number | null;
  seen_count?: number | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  title?: string | null;
  summary?: string | null;
  source_ref?: string | null;
  suggested_files?: string[] | null;
  spec_snapshot?: Record<string, unknown> | null;
}

export interface CostStat { median_cost_usd: number; median_input_tokens: number; runs: number }

export interface ScoringContext {
  /** Scanner breaker stats (VTID-04667). Null/!ok → no history. */
  breakers?: LoadedBreakers | null;
  /** Per breaker key, from dev_autopilot_outcomes agent_runs. */
  costByKey?: Map<string, CostStat> | null;
  /** Code-index lookup; null → the file check is skipped. */
  fileExists?: ((path: string) => boolean) | null;
  nowMs?: number;
}

export interface QualityJson {
  version: number;
  value: number;
  confidence: number;
  success_odds: number;
  expected_cost_usd: number;
  expected_input_tokens: number;
  executable: boolean;
  basis: {
    audience: string;
    severity: string;
    frequency: string;
    trend: string;
    confidence: string[];
    success_odds: string;
    cost: string;
  };
  scored_at: string;
}

export interface PriorityResult {
  priority_score: number;
  quality: QualityJson;
  impact_score: number;
  effort_score: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Event count from the snapshot or a "N occurrences / failure(s) / events" phrase. */
export function extractEventCount(row: PriorityRow): number | null {
  const s = row.spec_snapshot || {};
  for (const k of ['event_count', 'count', 'occurrences']) {
    const n = Number((s as Record<string, unknown>)[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const text = `${row.summary || ''} ${row.title || ''}`;
  const m = text.match(/(\d+)\s*(occurrences|failure\(s\)|failures|errors|events)/i);
  return m ? Number(m[1]) : null;
}

/** Concrete file paths named by the row (snapshot file_path, suggested files). */
export function extractFilePaths(row: PriorityRow): string[] {
  const out = new Set<string>();
  const s = row.spec_snapshot || {};
  const fp = str((s as Record<string, unknown>).file_path);
  if (fp && fp.includes('/')) out.add(fp.replace(/^\.\//, ''));
  const lists = [row.suggested_files, (s as Record<string, unknown>).suggested_files, (s as Record<string, unknown>).files];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const p = str(f);
      if (p && p.includes('/')) out.add(p.replace(/^\.\//, ''));
    }
  }
  return [...out];
}

function audienceFor(row: PriorityRow): { audience: Audience; why: string } {
  const signal = str((row.spec_snapshot || {} as Record<string, unknown>).signal_type as unknown);
  if (signal && SIGNAL_AUDIENCE[signal]) return { audience: SIGNAL_AUDIENCE[signal], why: `signal ${signal}` };
  const src = str(row.source_type);
  if (src && SOURCE_AUDIENCE[src]) return { audience: SOURCE_AUDIENCE[src], why: `source ${src}` };
  return { audience: DEFAULT_AUDIENCE, why: 'unknown source (default)' };
}

function severityFor(row: PriorityRow): { weight: number; why: string } {
  const s = row.spec_snapshot || {};
  for (const [label, v] of [['severity', (s as Record<string, unknown>).severity], ['risk_class', row.risk_class], ['risk_level', row.risk_level]] as const) {
    const key = str(v)?.toLowerCase();
    if (key && SEVERITY_WEIGHTS[key] !== undefined) return { weight: SEVERITY_WEIGHTS[key], why: `${label} ${key}` };
  }
  const impact = Number(row.impact_score);
  if (Number.isFinite(impact) && impact > 0) return { weight: clamp01(impact / 10), why: `legacy impact ${impact}/10` };
  return { weight: SEVERITY_WEIGHTS.medium, why: 'unknown (medium)' };
}

function frequencyFor(seen: number, events: number | null): { weight: number; why: string } {
  // seen_count 1 → 0.29, 3 → 0.58, 10 → 1.0 (log scale); events 100+ → 1.0.
  const seenW = clamp01(Math.log2(1 + Math.max(1, seen)) / Math.log2(11));
  const eventW = events ? clamp01(Math.log10(1 + events) / 2) : 0;
  const w = Math.max(seenW, eventW);
  return { weight: w, why: `seen ${seen}×${events ? `, ${events} events` : ''}` };
}

function trendFor(row: PriorityRow, nowMs: number): { factor: number; why: string } {
  const last = Date.parse(row.last_seen_at || row.created_at || '');
  if (!Number.isFinite(last)) return { factor: 1, why: 'no timestamp (neutral)' };
  const days = Math.max(0, (nowMs - last) / 86400000);
  const step = TREND_STEPS.find((t) => days <= t.max_days)!;
  return { factor: step.factor, why: step.label };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: per-key medians of recorded agent runs. */
export function computeCostStats(runsByKey: Map<string, Array<{ cost_usd: number; input_tokens: number }>>): Map<string, CostStat> {
  const out = new Map<string, CostStat>();
  for (const [key, runs] of runsByKey) {
    if (runs.length === 0) continue;
    out.set(key, {
      median_cost_usd: round(median(runs.map((r) => r.cost_usd)), 6),
      median_input_tokens: Math.round(median(runs.map((r) => r.input_tokens))),
      runs: runs.length,
    });
  }
  return out;
}

/** True when this row is a developer recommendation P2 scores. */
export function isScorableDeveloperRecommendation(row: { user_id?: string | null; source_type?: string | null }): boolean {
  return !row.user_id && row.source_type !== 'community' && row.source_type !== 'operator_onramp' && !!row.source_type;
}

/** Executable = has an autonomous executor (operator_onramp is never scored). */
export function isExecutableRecommendation(row: { source_type?: string | null }): boolean {
  return isExecutableSourceType(row.source_type ?? null) && row.source_type !== 'operator_onramp';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreRecommendation(row: PriorityRow, ctx: ScoringContext = {}): PriorityResult {
  const nowMs = ctx.nowMs ?? Date.now();
  const executable = isExecutableRecommendation(row);
  const seen = Math.max(1, Number(row.seen_count) || 1);
  const events = extractEventCount(row);

  // value
  const aud = audienceFor(row);
  const sev = severityFor(row);
  const freq = frequencyFor(seen, events);
  const trend = trendFor(row, nowMs);
  const value = clamp01(
    (AUDIENCE_WEIGHTS[aud.audience] * VALUE_MIX.audience + sev.weight * VALUE_MIX.severity + freq.weight * VALUE_MIX.frequency) * trend.factor,
  );

  // confidence
  const confBasis: string[] = [];
  let confidence: number = CONFIDENCE_WEIGHTS.base;
  const files = extractFilePaths(row);
  if (files.length > 0) {
    confidence += CONFIDENCE_WEIGHTS.concrete_file;
    confBasis.push(`names ${files.length} file(s)`);
    if (ctx.fileExists) {
      const known = files.filter((f) => ctx.fileExists!(f));
      if (known.length > 0) {
        confidence += CONFIDENCE_WEIGHTS.file_in_index;
        confBasis.push('file exists in the code index');
      } else {
        confidence += CONFIDENCE_WEIGHTS.file_missing_from_index;
        confBasis.push('no named file exists in the code index');
      }
    }
  }
  if (events !== null && events >= 10) {
    confidence += CONFIDENCE_WEIGHTS.events_10_plus;
    confBasis.push(`${events} events`);
  } else if (events !== null && events >= 3) {
    confidence += CONFIDENCE_WEIGHTS.events_3_plus;
    confBasis.push(`${events} events`);
  }
  if (seen >= 2) {
    confidence += CONFIDENCE_WEIGHTS.reproduced;
    confBasis.push(`reproduced across ${seen} runs`);
  }
  const s = row.spec_snapshot || {};
  if (str((s as Record<string, unknown>).scanner) || str((s as Record<string, unknown>).rule)) {
    confidence += CONFIDENCE_WEIGHTS.scanner_id;
    confBasis.push('named scanner/rule');
  } else if (str(row.source_ref)) {
    confidence += CONFIDENCE_WEIGHTS.source_ref;
    confBasis.push('source reference');
  }
  confidence = clamp01(confidence);

  // success odds
  let successOdds: number;
  let oddsWhy: string;
  const key = breakerKeyFor(row);
  if (!executable) {
    successOdds = NON_EXECUTABLE_SUCCESS_PRIOR;
    oddsWhy = `non-executable type: fixed prior ${NON_EXECUTABLE_SUCCESS_PRIOR}`;
  } else if (!ctx.breakers || !ctx.breakers.ok) {
    successOdds = SUCCESS_ODDS_NO_HISTORY;
    oddsWhy = 'execution history unavailable: prior 0.5';
  } else {
    const st = key ? ctx.breakers.states.get(key) : undefined;
    const samples = st?.samples ?? 0;
    const successes = st?.successes ?? 0;
    successOdds = (successes + 1) / (samples + 2);
    oddsWhy = `${key || 'unknown'}: ${successes}/${samples} recent executions landed (Laplace)`;
  }

  // cost
  const cost = executable && key ? ctx.costByKey?.get(key) : undefined;
  const expectedCost = cost ? cost.median_cost_usd : DEFAULT_EXPECTED_COST_USD;
  const expectedTokens = cost ? cost.median_input_tokens : DEFAULT_EXPECTED_INPUT_TOKENS;
  const costWhy = cost
    ? `median of ${cost.runs} recorded agent run(s) for ${key}`
    : `prior $${DEFAULT_EXPECTED_COST_USD} (${executable ? 'no recorded runs' : 'non-executable'})`;

  const priority = (value * confidence * successOdds) / Math.max(expectedCost, COST_FLOOR_USD);

  return {
    priority_score: round(priority),
    impact_score: Math.max(1, Math.min(10, Math.round(1 + value * 9))),
    effort_score: Math.max(1, Math.min(10, Math.round(1 + 9 * clamp01(expectedCost / EFFORT_COST_CEILING_USD)))),
    quality: {
      version: QUALITY_VERSION,
      value: round(value),
      confidence: round(confidence),
      success_odds: round(successOdds),
      expected_cost_usd: round(expectedCost, 6),
      expected_input_tokens: expectedTokens,
      executable,
      basis: {
        audience: `${aud.audience} (${aud.why})`,
        severity: sev.why,
        frequency: freq.why,
        trend: trend.why,
        confidence: confBasis,
        success_odds: oddsWhy,
        cost: costWhy,
      },
      scored_at: new Date(nowMs).toISOString(),
    },
  };
}
