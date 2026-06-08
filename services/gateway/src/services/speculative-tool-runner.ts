/**
 * Speculative tool runner — Phase 1 W1 (VTID-03181 VOICE-LAT).
 *
 * Pre-executes a tool call based on a partial-transcript intent prediction
 * BEFORE the user finishes speaking. When the final transcript confirms
 * the predicted intent, the result is already cached and we save the
 * round-trip latency.
 *
 * Strict safety rules (never relaxed):
 *   1. ONLY read-only tools are eligible. Mutation tools (memory writes,
 *      intent creates, calendar writes, message sends) are excluded by
 *      `READ_ONLY_TOOLS` allowlist below — if a tool's name is not in
 *      this set, it never runs speculatively.
 *   2. Confidence threshold: predicted intent must have >= 0.95
 *      confidence from the prediction model before speculation fires.
 *   3. Results are cached for at most 30s and dropped if the final
 *      transcript doesn't match the speculated intent.
 *
 * Gated behind FEATURE_SPECULATIVE_TOOLS_ENV (default off).
 * Wired by orb-live in a follow-up PR; this PR only ships the runtime.
 */

import { emitOasisEvent } from './oasis-event-service';
import { isFeatureLive } from './feature-flags';

const FEATURE_NAME = 'SPECULATIVE_TOOLS';
const CONFIDENCE_THRESHOLD = 0.95;
const RESULT_CACHE_TTL_MS = 30_000;
const PREDICTION_DEADLINE_MS = 250; // skip speculation if prediction took > 250ms

// READ-ONLY tools that are safe to speculate on. ANY tool not in this set
// is excluded. Adding to this list requires a careful review — a single
// "read" tool that turns out to mutate state would break the safety
// contract.
const READ_ONLY_TOOLS = new Set([
  'get_today_plan',
  'get_recent_memory',
  'get_calendar_today',
  'get_calendar_week',
  'get_autopilot_recommendations',
  'get_pillar_status',
  'get_vitana_index_overview',
  'list_intents_board',
  'find_partner',
  'find_member',
]);

export interface ToolPrediction<TArgs> {
  tool_name: string;
  arguments: TArgs;
  confidence: number;
  /** ms taken by the prediction model itself. */
  prediction_ms: number;
}

export interface SpeculationContext {
  session_id: string;
  actor_id?: string;
  partial_transcript: string;
}

interface CachedResult {
  tool_name: string;
  arguments_hash: string;
  result: unknown;
  cached_at: number;
}

const resultCache = new Map<string, CachedResult>();

function argumentsHash(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function cacheKey(sessionId: string, toolName: string, argsHash: string): string {
  return `${sessionId}::${toolName}::${argsHash}`;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of resultCache.entries()) {
    if (now - entry.cached_at > RESULT_CACHE_TTL_MS) {
      resultCache.delete(key);
    }
  }
}

/**
 * Pre-execute a predicted tool if eligible. Returns true if speculation
 * fired (result is in the cache for confirmTool to retrieve).
 */
export async function maybeSpeculate<TArgs>(
  prediction: ToolPrediction<TArgs>,
  ctx: SpeculationContext,
  executor: (toolName: string, args: TArgs) => Promise<unknown>,
): Promise<boolean> {
  if (!isFeatureLive(FEATURE_NAME)) return false;
  if (!READ_ONLY_TOOLS.has(prediction.tool_name)) return false;
  if (prediction.confidence < CONFIDENCE_THRESHOLD) return false;
  if (prediction.prediction_ms > PREDICTION_DEADLINE_MS) return false;

  pruneCache();

  const argsHash = argumentsHash(prediction.arguments);
  const key = cacheKey(ctx.session_id, prediction.tool_name, argsHash);
  if (resultCache.has(key)) return false; // already speculated

  const started = Date.now();
  try {
    const result = await executor(prediction.tool_name, prediction.arguments);
    resultCache.set(key, {
      tool_name: prediction.tool_name,
      arguments_hash: argsHash,
      result,
      cached_at: Date.now(),
    });
    await emitOasisEvent({
      vtid: 'VTID-03181',
      type: 'orb.turn.received', // reused; metadata.speculation distinguishes
      source: 'gateway/speculative-tool-runner',
      status: 'success',
      message: `speculated ${prediction.tool_name} confidence=${prediction.confidence.toFixed(2)}`,
      actor_id: ctx.actor_id,
      payload: {
        session_id: ctx.session_id,
        speculation: true,
        tool_name: prediction.tool_name,
        confidence: prediction.confidence,
        prediction_ms: prediction.prediction_ms,
        speculation_ms: Date.now() - started,
        partial_transcript_len: ctx.partial_transcript.length,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieve a pre-executed result. Called when the final transcript is in
 * and we know which tool was actually chosen. Returns undefined if no
 * speculation matched.
 */
export function confirmSpeculation<T>(
  sessionId: string,
  toolName: string,
  args: unknown,
): T | undefined {
  if (!isFeatureLive(FEATURE_NAME)) return undefined;
  pruneCache();
  const key = cacheKey(sessionId, toolName, argumentsHash(args));
  const hit = resultCache.get(key);
  if (!hit) return undefined;
  resultCache.delete(key);
  return hit.result as T;
}

/**
 * Test-only: clear the cache between runs.
 */
export function __resetSpeculationCacheForTests(): void {
  resultCache.clear();
}
