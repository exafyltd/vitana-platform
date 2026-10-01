/**
 * VTID-04669 (P3 of docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md): one
 * bounded quality review before a developer recommendation card is shown.
 *
 * For open developer recommendations that pass the P2 floor
 * (passesQualityFloor, VTID-04668) and carry no quality.review yet, ONE
 * planner-stage review runs through the shared stage loop
 * (runStageToolLoop, VTID-04231) with the code-index tools
 * dev_index_query / dev_get_risk (VTID-04229, wired like the spec generator
 * in routes/specs.ts). The planner stage stays on its llm_routing_policy
 * (Bedrock) — no provider override, never Google or the direct Anthropic API.
 *
 * The model answers in strict JSON:
 *   {verdict:'keep'|'drop', problem, evidence:[...], files:[{path, risk}],
 *    acceptance:[...], why_now, drop_reason?}
 *
 *   keep → quality.review is stored; the card becomes visible.
 *   drop, or an executable type with no concrete file or no evidence →
 *     status 'auto_archived' (NOT 'rejected': rejected is a human decision
 *     and starts the 30-day fingerprint block, VTID-04666) with
 *     quality.review.drop_reason.
 *   unparseable → no verdict; quality.review_attempts is incremented and
 *     the row is retried on a later tick, at most REVIEW_MAX_ATTEMPTS times.
 *
 * Tick: every 15 min, ≤ 5 rows, daily cap AUTOPILOT_QUALITY_REVIEW_DAILY_CAP
 * (default 40, counted from quality.review.reviewed_at today, UTC). Kill
 * switch AUTOPILOT_QUALITY_REVIEW_ENABLED — the exact string 'false'
 * disables; anything else leaves it on. One OASIS event
 * autopilot.recommendation.quality_reviewed per verdict.
 */
import { emitOasisEvent } from '../oasis-event-service';
import { runStageToolLoop } from '../llm-stage-tool-loop';
import {
  codeIndexRouterTools,
  isCodeIndexToolName,
  loadCodeIndex,
  runCodeIndexTool,
  type CodeIndexBundle,
} from '../codeintel-index';
import { passesQualityFloor, isExecutableRecommendation } from './priority';
import { OPEN_DEVELOPER_FILTER } from './scoring-service';
import { isQualityReviewEnabled } from './review-config';
import { defaultQualityPatch, defaultQualityQuery, type QualityPatch, type QualityQuery } from './rest';

const LOG_PREFIX = '[recommendation-quality-review]';

export const REVIEW_VTID = 'VTID-04669';
export const REVIEW_STAGE = 'planner' as const;
export const REVIEW_SERVICE = 'recommendation-quality-review';
export const REVIEW_MAX_TURNS = 4;
export const REVIEW_MAX_TOOL_CALLS = 6;
export const REVIEW_DEADLINE_MS = 90_000;
export const REVIEW_MAX_TOKENS = 2000;
export const REVIEW_EVERY_MS = 15 * 60 * 1000;
export const REVIEW_BATCH = 5;
export const REVIEW_CANDIDATE_WINDOW = 50;
export const REVIEW_MAX_ATTEMPTS = 2;
export const DEFAULT_REVIEW_DAILY_CAP = 40;
export const REVIEW_REPO = 'exafyltd/vitana-platform';
export const REVIEW_INDEX_TIMEOUT_MS = 3000;
/** The two index tools a reviewer needs (the path tool is not declared). */
export const REVIEW_TOOL_NAMES = ['dev_index_query', 'dev_get_risk'] as const;

export { isQualityReviewEnabled };

/** AUTOPILOT_QUALITY_REVIEW_DAILY_CAP (positive integer), default 40. */
export function resolveReviewDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTOPILOT_QUALITY_REVIEW_DAILY_CAP;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REVIEW_DAILY_CAP;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REVIEW_DAILY_CAP;
}

// ---------------------------------------------------------------------------
// Prompt + parse
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM_PROMPT = [
  'You review one engineering recommendation for the Vitana platform before a developer sees it.',
  'Your job is to decide whether it names a concrete, real defect worth a developer\'s attention now.',
  'Use dev_index_query to find the files and code the recommendation is about, and dev_get_risk to learn their change risk.',
  'Keep it only when you can point to concrete evidence (file paths, symbols, counts, event topics) and state what fixing it achieves.',
  'Drop it when it is noise, a duplicate of normal behaviour, already handled, too vague to act on, or the named code does not exist.',
  'Answer with one JSON object and nothing else, with these keys:',
  '{"verdict":"keep"|"drop","problem":string,"evidence":[string],"files":[{"path":string,"risk":string}],"acceptance":[string],"why_now":string,"drop_reason":string}',
  'drop_reason is required when verdict is "drop". Write every field in English.',
].join('\n');

export interface ReviewCandidate {
  id: string;
  title?: string | null;
  summary?: string | null;
  source_type?: string | null;
  source_ref?: string | null;
  domain?: string | null;
  risk_class?: string | null;
  seen_count?: number | null;
  spec_snapshot?: Record<string, unknown> | null;
  quality?: Record<string, unknown> | null;
}

function clip(s: unknown, n: number): string {
  const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : JSON.stringify(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function buildReviewPrompt(rec: ReviewCandidate): string {
  const q = rec.quality || {};
  return [
    'Review this recommendation.',
    `Title: ${clip(rec.title, 300)}`,
    `Summary: ${clip(rec.summary, 1500)}`,
    `Source: ${rec.source_type || 'unknown'}${rec.source_ref ? ` (${clip(rec.source_ref, 200)})` : ''}`,
    `Domain: ${rec.domain || 'n/a'}; risk class: ${rec.risk_class || 'n/a'}; seen ${rec.seen_count ?? 1} time(s)`,
    `Executable by the autopilot: ${isExecutableRecommendation(rec) ? 'yes' : 'no (a developer would do it by hand)'}`,
    `Signal details: ${clip(rec.spec_snapshot || {}, 2000)}`,
    `Priority components: ${clip({ value: q.value, confidence: q.confidence, success_odds: q.success_odds, expected_cost_usd: q.expected_cost_usd, basis: q.basis }, 1500)}`,
    'Locate the code first, then answer with the JSON object only.',
  ].join('\n');
}

export interface ReviewFile { path: string; risk: string }
export interface ReviewVerdict {
  verdict: 'keep' | 'drop';
  problem: string;
  evidence: string[];
  files: ReviewFile[];
  acceptance: string[];
  why_now: string;
  drop_reason?: string;
}

function strList(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' ? JSON.stringify(x) : String(x ?? '')))
    .filter((x) => x.length > 0).slice(0, max).map((x) => x.slice(0, 500));
}

function fileList(v: unknown): ReviewFile[] {
  if (!Array.isArray(v)) return [];
  const out: ReviewFile[] = [];
  for (const f of v) {
    if (typeof f === 'string' && f.trim()) out.push({ path: f.trim(), risk: 'unknown' });
    else if (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string' && (f as { path: string }).path.trim()) {
      const risk = (f as { risk?: unknown }).risk;
      out.push({ path: (f as { path: string }).path.trim(), risk: typeof risk === 'string' && risk.trim() ? risk.trim().slice(0, 200) : 'unknown' });
    }
    if (out.length >= 20) break;
  }
  return out;
}

/** The first balanced {...} object in a text (code fences / prose tolerated). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Tolerant parse; null when there is no usable verdict. */
export function parseReviewVerdict(text: string | null | undefined): ReviewVerdict | null {
  if (!text || typeof text !== 'string') return null;
  const raw = firstJsonObject(text.replace(/```(?:json)?/gi, ''));
  if (!raw) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const v = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  if (v !== 'keep' && v !== 'drop') return null;
  const dropReason = typeof obj.drop_reason === 'string' && obj.drop_reason.trim() ? obj.drop_reason.trim().slice(0, 500) : undefined;
  return {
    verdict: v,
    problem: typeof obj.problem === 'string' ? obj.problem.trim().slice(0, 1000) : '',
    evidence: strList(obj.evidence),
    files: fileList(obj.files),
    acceptance: strList(obj.acceptance),
    why_now: typeof obj.why_now === 'string' ? obj.why_now.trim().slice(0, 500) : '',
    ...(v === 'drop' || dropReason ? { drop_reason: dropReason || 'dropped by review (no reason given)' } : {}),
  };
}

/**
 * keep / archive. An executable recommendation the reviewer kept without a
 * concrete file or without evidence is archived: the autopilot could not
 * act on it anyway.
 */
export function decideReviewOutcome(
  rec: { source_type?: string | null },
  verdict: ReviewVerdict,
): { action: 'keep' | 'archive'; drop_reason?: string } {
  if (verdict.verdict === 'drop') return { action: 'archive', drop_reason: verdict.drop_reason || 'dropped by review' };
  if (isExecutableRecommendation(rec) && (verdict.files.length === 0 || verdict.evidence.length === 0)) {
    return { action: 'archive', drop_reason: 'no concrete file or evidence for an executable recommendation' };
  }
  return { action: 'keep' };
}

// ---------------------------------------------------------------------------
// One review
// ---------------------------------------------------------------------------

export interface ReviewRunResult {
  verdict: ReviewVerdict | null;
  provider?: string;
  model?: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  tools_used: string[];
  error?: string;
}

export interface ReviewDeps {
  query?: QualityQuery;
  patch?: QualityPatch;
  runLoop?: typeof runStageToolLoop;
  /** Loads the code index; null / throws → review without tools. */
  loadIndex?: () => Promise<CodeIndexBundle | null>;
  emit?: typeof emitOasisEvent;
  env?: NodeJS.ProcessEnv;
}

async function defaultLoadIndex(): Promise<CodeIndexBundle | null> {
  const loaded = await Promise.race([
    loadCodeIndex(REVIEW_REPO),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('code index load timed out')), REVIEW_INDEX_TIMEOUT_MS).unref?.()),
  ]);
  return loaded.bundle;
}

export function reviewRouterTools() {
  return codeIndexRouterTools().filter((t) => (REVIEW_TOOL_NAMES as readonly string[]).includes(t.name));
}

/** Runs the bounded planner-stage review for one recommendation. Never throws. */
export async function reviewRecommendation(rec: ReviewCandidate, deps: ReviewDeps = {}): Promise<ReviewRunResult> {
  let bundle: CodeIndexBundle | null = null;
  try {
    bundle = await (deps.loadIndex || defaultLoadIndex)();
  } catch (err) {
    console.warn(`${LOG_PREFIX} code index unavailable — reviewing ${rec.id.slice(0, 8)} without index tools: ${err instanceof Error ? err.message : String(err)}`);
  }
  const b = bundle;
  try {
    const loop = await (deps.runLoop || runStageToolLoop)({
      stage: REVIEW_STAGE,
      service: REVIEW_SERVICE,
      vtid: REVIEW_VTID,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      prompt: buildReviewPrompt(rec),
      tools: b ? reviewRouterTools() : [],
      execute: async (name, args) => {
        if (!b) return { result: `no codebase index is loaded in this run (${name})`, isError: true };
        if (!(REVIEW_TOOL_NAMES as readonly string[]).includes(name) || !isCodeIndexToolName(name)) {
          return { result: `unknown tool: ${name}`, isError: true };
        }
        const out = runCodeIndexTool(name, args, b);
        return { result: out.text, isError: !out.ok };
      },
      maxTurns: b ? REVIEW_MAX_TURNS : 1,
      maxToolCalls: b ? REVIEW_MAX_TOOL_CALLS : 0,
      deadlineMs: REVIEW_DEADLINE_MS,
      maxTokens: REVIEW_MAX_TOKENS,
      allowFallback: true,
      // No providerOverride: the planner stage's routing policy (Bedrock) decides.
    });
    return {
      verdict: loop.ok ? parseReviewVerdict(loop.text) : null,
      provider: loop.provider,
      model: loop.model,
      input_tokens: loop.usage?.inputTokens ?? 0,
      output_tokens: loop.usage?.outputTokens ?? 0,
      tool_calls: loop.toolCalls,
      tools_used: loop.toolNames,
      error: loop.ok ? undefined : loop.error,
    };
  } catch (err) {
    return { verdict: null, input_tokens: 0, output_tokens: 0, tool_calls: 0, tools_used: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

let lastReviewTickMs = 0;

/** Test hook. */
export function resetQualityReviewState(): void {
  lastReviewTickMs = 0;
}

export function utcDayStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Rows a review should consider now (pure): scored, above the floor, not reviewed, attempts left. */
export function selectReviewCandidates<T extends ReviewCandidate & { status?: string | null }>(rows: T[], limit: number): T[] {
  const out: T[] = [];
  for (const r of rows || []) {
    if (out.length >= limit) break;
    const q = r.quality;
    if (!q || typeof q !== 'object') continue; // not scored yet
    if (q.review) continue;
    if ((Number(q.review_attempts) || 0) >= REVIEW_MAX_ATTEMPTS) continue;
    if (!passesQualityFloor(q as never)) continue; // below the P2 floor: never spend a model call
    out.push(r);
  }
  return out;
}

export interface ReviewTickResult {
  ran: boolean;
  reason?: string;
  reviewed: number;
  kept: number;
  archived: number;
  no_verdict: number;
  cap_remaining?: number;
}

export async function qualityReviewTick(nowMs: number = Date.now(), deps: ReviewDeps = {}): Promise<ReviewTickResult> {
  const env = deps.env || process.env;
  if (!isQualityReviewEnabled(env)) return { ran: false, reason: 'disabled', reviewed: 0, kept: 0, archived: 0, no_verdict: 0 };
  if (nowMs - lastReviewTickMs < REVIEW_EVERY_MS) return { ran: false, reason: 'throttled', reviewed: 0, kept: 0, archived: 0, no_verdict: 0 };
  lastReviewTickMs = nowMs;
  const query = deps.query || defaultQualityQuery;
  const patch = deps.patch || defaultQualityPatch;
  const emit = deps.emit || emitOasisEvent;
  const result: ReviewTickResult = { ran: true, reviewed: 0, kept: 0, archived: 0, no_verdict: 0 };
  try {
    const cap = resolveReviewDailyCap(env);
    const todayR = await query<Array<{ id: string }>>(
      `/rest/v1/autopilot_recommendations?user_id=is.null`
      + `&quality->review->>reviewed_at=gte.${encodeURIComponent(utcDayStartIso(nowMs))}&select=id&limit=${Math.max(cap, 1) + 1}`,
    );
    if (!todayR.ok || !Array.isArray(todayR.data)) return { ...result, ran: false, reason: 'cap_read_failed' };
    const remaining = Math.max(0, cap - todayR.data.length);
    result.cap_remaining = remaining;
    if (remaining === 0) return { ...result, ran: false, reason: 'daily_cap' };

    const candR = await query<Array<ReviewCandidate & { status?: string | null }>>(
      `/rest/v1/autopilot_recommendations?${OPEN_DEVELOPER_FILTER}&status=eq.new`
      + `&quality=not.is.null&quality->review=is.null`
      + `&order=priority_score.desc.nullslast&limit=${REVIEW_CANDIDATE_WINDOW}`
      + `&select=id,title,summary,source_type,source_ref,domain,risk_class,seen_count,spec_snapshot,quality,status`,
    );
    if (!candR.ok || !Array.isArray(candR.data)) return { ...result, ran: false, reason: 'candidate_read_failed' };
    const batch = selectReviewCandidates(candR.data, Math.min(REVIEW_BATCH, remaining));

    for (const rec of batch) {
      const run = await reviewRecommendation(rec, deps);
      result.reviewed++;
      const prior = (rec.quality || {}) as Record<string, unknown>;
      const attempts = (Number(prior.review_attempts) || 0) + 1;
      const reviewedAt = new Date(nowMs).toISOString();
      if (!run.verdict) {
        result.no_verdict++;
        await patch(`/rest/v1/autopilot_recommendations?id=eq.${rec.id}&status=eq.new`, {
          quality: { ...prior, review_attempts: attempts, review_last_attempt_at: reviewedAt },
        });
        console.warn(`${LOG_PREFIX} no usable verdict for ${rec.id.slice(0, 8)} (attempt ${attempts}/${REVIEW_MAX_ATTEMPTS})${run.error ? `: ${run.error}` : ''}`);
        continue;
      }
      const outcome = decideReviewOutcome(rec, run.verdict);
      const review = {
        ...run.verdict,
        verdict: outcome.action === 'keep' ? 'keep' : 'drop',
        ...(outcome.drop_reason ? { drop_reason: outcome.drop_reason } : {}),
        reviewed_at: reviewedAt,
        provider: run.provider ?? null,
        model: run.model ?? null,
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        tool_calls: run.tool_calls,
      };
      const body: Record<string, unknown> = { quality: { ...prior, review, review_attempts: attempts } };
      if (outcome.action === 'archive') {
        body.status = 'auto_archived';
        body.updated_at = reviewedAt;
      }
      const p = await patch(`/rest/v1/autopilot_recommendations?id=eq.${rec.id}&status=eq.new`, body);
      if (!p.ok) {
        console.warn(`${LOG_PREFIX} review PATCH failed for ${rec.id.slice(0, 8)}: ${p.error}`);
        continue;
      }
      if (outcome.action === 'keep') result.kept++;
      else result.archived++;
      await emit({
        vtid: REVIEW_VTID,
        type: 'autopilot.recommendation.quality_reviewed',
        source: 'recommendation-quality',
        status: outcome.action === 'keep' ? 'info' : 'warning',
        message: outcome.action === 'keep'
          ? `Recommendation ${rec.id.slice(0, 8)} kept by quality review`
          : `Recommendation ${rec.id.slice(0, 8)} auto-archived by quality review: ${outcome.drop_reason}`,
        payload: {
          recommendation_id: rec.id,
          verdict: review.verdict,
          drop_reason: outcome.drop_reason ?? null,
          source_type: rec.source_type ?? null,
          provider: run.provider ?? null,
          model: run.model ?? null,
          input_tokens: run.input_tokens,
          output_tokens: run.output_tokens,
          tool_calls: run.tool_calls,
        },
      }).catch(() => undefined);
    }
    if (result.reviewed > 0) {
      console.log(`${LOG_PREFIX} reviewed ${result.reviewed}: ${result.kept} kept, ${result.archived} archived, ${result.no_verdict} without verdict (${remaining - result.reviewed} left today)`);
    }
    return result;
  } catch (err) {
    console.warn(`${LOG_PREFIX} tick failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...result, reason: 'error' };
  }
}
