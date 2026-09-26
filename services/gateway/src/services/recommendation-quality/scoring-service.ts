/**
 * VTID-04668: writes the P2 score (priority.ts) onto developer
 * recommendations.
 *
 *  - scoreNewDeveloperRecommendations(since): called right after the three
 *    developer writers insert (ingestScan, POST /impact-ingest, the
 *    recommendation generator's oasis/roadmap/health/behavior RPC inserts —
 *    the RPC takes no score fields, so every path PATCHes after insert).
 *  - rescoreTick(): every RESCORE_EVERY_MS over up to RESCORE_BATCH open
 *    developer recs, oldest score first, so success odds and cost stay
 *    current as executions land.
 *
 * Fail-open everywhere: a scoring or read error is logged and never blocks
 * an insert or a listing. Community rows (user_id set / source_type
 * community) and operator_onramp rows are never touched.
 */
import { loadScannerBreakers, breakerKeyFor, type LoadedBreakers } from '../dev-autopilot-scanner-breaker';
import { extractAgentRuns } from '../dev-autopilot-approval-gates';
import { chunkIds } from '../dev-autopilot-pipeline-guards';
import {
  computeCostStats,
  isScorableDeveloperRecommendation,
  scoreRecommendation,
  type CostStat,
  type PriorityRow,
  type ScoringContext,
} from './priority';
import { defaultQualityPatch, defaultQualityQuery, type QualityPatch, type QualityQuery } from './rest';

const LOG_PREFIX = '[recommendation-quality]';

export const RESCORE_EVERY_MS = 30 * 60 * 1000;
export const RESCORE_BATCH = 200;
/** Outcome rows read for cost medians. */
export const COST_OUTCOME_WINDOW = 500;
export const COST_CACHE_MS = 10 * 60 * 1000;
/** Insert paths look back this far before their own start (gateway vs DB clock). */
export const SCORING_CLOCK_SKEW_MS = 60_000;

/** Columns scoring needs. */
export const SCORING_SELECT =
  'id,source_type,user_id,status,risk_class,risk_level,impact_score,effort_score,seen_count,'
  + 'first_seen_at,last_seen_at,created_at,title,summary,source_ref,suggested_files,spec_snapshot,quality';

/** PostgREST filter for open developer recommendations. */
export const OPEN_DEVELOPER_FILTER =
  'user_id=is.null&status=in.(new,snoozed)'
  + '&source_type=not.in.(community,operator_onramp)'
  + '&or=(expires_at.is.null,expires_at.gt.now())';

export interface ScoringDeps {
  query?: QualityQuery;
  patch?: QualityPatch;
  /** Code-index loader for the file-exists confidence signal; null → skipped. */
  loadIndex?: (() => Promise<IndexFileView | null>) | null;
  nowMs?: number;
}

export interface IndexFileView {
  risk?: { files?: Record<string, unknown> } | null;
  byFile?: Map<string, unknown> | null;
}

export function indexHasFile(index: IndexFileView, path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return !!(index.risk?.files && Object.prototype.hasOwnProperty.call(index.risk.files, p))
    || !!(index.byFile && index.byFile.has(p));
}

let costCache: { at: number; value: Map<string, CostStat> } | null = null;
let lastRescoreMs = 0;

/** Test hook. */
export function resetScoringServiceState(): void {
  costCache = null;
  lastRescoreMs = 0;
}

/**
 * Median agent cost / input tokens per breaker key, from the last
 * COST_OUTCOME_WINDOW dev_autopilot_outcomes rows that carry agent runs
 * (extractAgentRuns — the same reader as the P4 per-finding budget).
 * A read failure returns an empty map (priors apply).
 */
export async function loadCostStats(query: QualityQuery, nowMs: number = Date.now()): Promise<Map<string, CostStat>> {
  if (costCache && nowMs - costCache.at < COST_CACHE_MS) return costCache.value;
  const out = await query<Array<{ finding_id: string | null; metadata: unknown }>>(
    `/rest/v1/dev_autopilot_outcomes?metadata->agent_runs=not.is.null`
    + `&order=created_at.desc&limit=${COST_OUTCOME_WINDOW}&select=finding_id,metadata`,
  );
  if (!out.ok || !Array.isArray(out.data)) return new Map();
  const ids = Array.from(new Set(out.data.map((r) => r.finding_id).filter((x): x is string => !!x)));
  const keyByFinding = new Map<string, string | null>();
  for (const chunk of chunkIds(ids)) {
    if (chunk.length === 0) continue;
    const recR = await query<Array<{ id: string; source_type: string | null; scanner: string | null; rule: string | null }>>(
      `/rest/v1/autopilot_recommendations?id=in.(${chunk.join(',')})`
      + `&select=id,source_type,scanner:spec_snapshot->>scanner,rule:spec_snapshot->>rule`,
    );
    if (!recR.ok || !Array.isArray(recR.data)) return new Map();
    for (const r of recR.data) keyByFinding.set(r.id, breakerKeyFor(r));
  }
  // Group rows by key first, then dedupe runs per key.
  const rowsByKey = new Map<string, Array<{ metadata: unknown }>>();
  for (const r of out.data) {
    const key = r.finding_id ? keyByFinding.get(r.finding_id) : null;
    if (!key) continue;
    const list = rowsByKey.get(key) || [];
    list.push({ metadata: r.metadata });
    rowsByKey.set(key, list);
  }
  const runsByKey = new Map<string, Array<{ cost_usd: number; input_tokens: number }>>();
  for (const [key, rows] of rowsByKey) runsByKey.set(key, extractAgentRuns(rows));
  const value = computeCostStats(runsByKey);
  costCache = { at: nowMs, value };
  return value;
}

/** Breakers (VTID-04667 reader, no transition events), cost medians and the optional index. */
export async function loadScoringContext(deps: ScoringDeps = {}): Promise<ScoringContext> {
  const query = deps.query || defaultQualityQuery;
  const nowMs = deps.nowMs ?? Date.now();
  let breakers: LoadedBreakers | null = null;
  try {
    // useCache:false — never populate the breaker cache without its transition
    // events (the auto-approve tick owns those, VTID-04667).
    breakers = await loadScannerBreakers(query, { emitTransitions: false, useCache: false, nowMs });
  } catch (err) {
    console.warn(`${LOG_PREFIX} breaker stats unavailable (priors apply): ${err instanceof Error ? err.message : String(err)}`);
  }
  let costByKey: Map<string, CostStat> = new Map();
  try {
    costByKey = await loadCostStats(query, nowMs);
  } catch (err) {
    console.warn(`${LOG_PREFIX} cost stats unavailable (priors apply): ${err instanceof Error ? err.message : String(err)}`);
  }
  let fileExists: ((p: string) => boolean) | null = null;
  if (deps.loadIndex) {
    try {
      const index = await deps.loadIndex();
      if (index) fileExists = (p) => indexHasFile(index, p);
    } catch {
      fileExists = null;
    }
  }
  return { breakers, costByKey, fileExists, nowMs };
}

/** The PATCH body for one row; keeps the P3 review fields already on it. */
export function buildScorePatch(row: PriorityRow & { quality?: unknown }, ctx: ScoringContext): Record<string, unknown> {
  const r = scoreRecommendation(row, ctx);
  const prior = row.quality && typeof row.quality === 'object' && !Array.isArray(row.quality)
    ? (row.quality as Record<string, unknown>) : {};
  const keep: Record<string, unknown> = {};
  for (const k of ['review', 'review_attempts', 'review_last_attempt_at']) if (prior[k] !== undefined) keep[k] = prior[k];
  return {
    priority_score: r.priority_score,
    quality: { ...r.quality, ...keep },
    impact_score: r.impact_score,
    effort_score: r.effort_score,
  };
}

export interface ScoreRunResult { ok: boolean; read: number; scored: number; failed: number; error?: string }

/** Scores the given rows and PATCHes each (open developer rows only). */
export async function scoreRows(rows: Array<PriorityRow & { quality?: unknown }>, deps: ScoringDeps = {}): Promise<ScoreRunResult> {
  const patch = deps.patch || defaultQualityPatch;
  const scorable = rows.filter((r) => r.id && isScorableDeveloperRecommendation(r));
  if (scorable.length === 0) return { ok: true, read: rows.length, scored: 0, failed: 0 };
  const ctx = await loadScoringContext(deps);
  let scored = 0;
  let failed = 0;
  for (const row of scorable) {
    try {
      const body = buildScorePatch(row, ctx);
      const p = await patch(`/rest/v1/autopilot_recommendations?id=eq.${row.id}&user_id=is.null`, body);
      if (p.ok) scored++;
      else {
        failed++;
        console.warn(`${LOG_PREFIX} score PATCH failed for ${String(row.id).slice(0, 8)}: ${p.error}`);
      }
    } catch (err) {
      failed++;
      console.warn(`${LOG_PREFIX} scoring failed for ${String(row.id).slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: true, read: rows.length, scored, failed };
}

/**
 * Scores open developer recommendations created at/after `sinceIso` that
 * have no score yet. Never throws — an insert path awaits it and must not
 * fail because of it.
 */
export async function scoreNewDeveloperRecommendations(sinceIso: string, deps: ScoringDeps = {}): Promise<ScoreRunResult> {
  try {
    const query = deps.query || defaultQualityQuery;
    const r = await query<Array<PriorityRow & { quality?: unknown }>>(
      `/rest/v1/autopilot_recommendations?${OPEN_DEVELOPER_FILTER}&quality=is.null`
      + `&created_at=gte.${encodeURIComponent(sinceIso)}`
      + `&order=created_at.desc&limit=${RESCORE_BATCH}&select=${SCORING_SELECT}`,
    );
    if (!r.ok || !Array.isArray(r.data)) return { ok: false, read: 0, scored: 0, failed: 0, error: 'read failed' };
    return await scoreRows(r.data, deps);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} scoring new recommendations failed (insert unaffected): ${error}`);
    return { ok: false, read: 0, scored: 0, failed: 0, error };
  }
}

/**
 * Rescore tick: at most once per RESCORE_EVERY_MS, up to RESCORE_BATCH open
 * developer recs, unscored and oldest-scored first. Never throws.
 */
export async function rescoreTick(nowMs: number = Date.now(), deps: ScoringDeps = {}): Promise<ScoreRunResult | null> {
  if (nowMs - lastRescoreMs < RESCORE_EVERY_MS) return null;
  lastRescoreMs = nowMs;
  try {
    const query = deps.query || defaultQualityQuery;
    const r = await query<Array<PriorityRow & { quality?: unknown }>>(
      `/rest/v1/autopilot_recommendations?${OPEN_DEVELOPER_FILTER}`
      + `&order=quality->>scored_at.asc.nullsfirst&limit=${RESCORE_BATCH}&select=${SCORING_SELECT}`,
    );
    if (!r.ok || !Array.isArray(r.data)) return { ok: false, read: 0, scored: 0, failed: 0, error: 'read failed' };
    const result = await scoreRows(r.data, { ...deps, nowMs });
    if (result.scored > 0 || result.failed > 0) {
      console.log(`${LOG_PREFIX} rescore: ${result.scored} scored, ${result.failed} failed of ${result.read} open developer recommendations`);
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} rescore tick failed: ${error}`);
    return { ok: false, read: 0, scored: 0, failed: 0, error };
  }
}
