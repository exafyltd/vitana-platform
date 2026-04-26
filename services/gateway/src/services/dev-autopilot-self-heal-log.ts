/**
 * Dev Autopilot — shared self_healing_log writer.
 *
 * Why this module exists:
 *   The Self-Healing UI (Command Hub → Autonomy → Self Healing) reads from
 *   self_healing_log. Failures earlier in the autopilot pipeline than
 *   `dev_autopilot_executions` (plan generation, approval safety gate,
 *   scanner ingest, worker spawn, etc.) used to never surface there. The
 *   bridge only fires for execution-level failures. So the Self-Healing
 *   screen showed a 7-day silence even while the autopilot was failing
 *   100% of plan attempts because of a missing binary.
 *
 *   This module is the single writer every stage calls when it fails.
 *   One function, one row shape, every failure visible.
 *
 * Schema reference:
 *   supabase/migrations/20260402000000_self_healing_tables.sql
 *   - vtid, endpoint, failure_class, confidence (0-1), diagnosis (jsonb),
 *     outcome (pending|escalated|failed|...), attempt_number,
 *     created_at, resolved_at
 */

const LOG_PREFIX = '[dev-autopilot-self-heal-log]';

export interface SupaConfig { url: string; key: string; }

/** Lifecycle stage at which a failure occurred. */
export type AutopilotFailureStage =
  | 'scan_ingest'         // POST /api/v1/dev-autopilot/scan failed inside synthesis
  | 'plan_gen'            // generatePlanVersion errored (worker spawn / Messages API)
  | 'plan_validate'       // plan output failed structural validation
  | 'approve_safety'      // safety gate blocked an approval
  | 'execute_pre'         // pre-LLM setup (file fetch, etc.) failed
  | 'execute_run'         // LLM call returned no usable output
  | 'execute_pr_open'     // PR creation step failed
  | 'execute_ci'          // CI red on opened PR
  | 'execute_merging'     // auto-merge blocked / repository protected
  | 'execute_deploy'      // EXEC-DEPLOY did not fire / failed
  | 'execute_verify'      // post-deploy verification failed
  | 'reconciler';         // reconciler timed out a non-terminal state

export interface AutopilotFailureArgs {
  stage: AutopilotFailureStage;
  /** VTID-DA-<exec-short> when an execution exists, or VTID-DA-FIND-<finding-short>
   *  when only a finding exists, or a stage-derived synthetic VTID. */
  vtid: string;
  /** Semantic identifier — usually the finding's file_path or
   *  `autopilot.{stage}` when no file is known. */
  endpoint: string;
  /** failure_class string. By convention: `dev_autopilot_<reason>`. */
  failure_class: string;
  /** Triage confidence 0-1; pass 0 if not run. */
  confidence?: number;
  /** Structured diagnosis: must include a `summary` for the UI. */
  diagnosis: Record<string, unknown>;
  /** Default 'failed' for terminal stage failures, 'escalated' when bridge
   *  ran but couldn't auto-fix, 'pending' when a retry is in flight. */
  outcome?: 'pending' | 'escalated' | 'failed' | 'fixed' | 'rolled_back';
  /** 1 for first occurrence; bridge increments per retry attempt. */
  attempt_number?: number;
}

/** Time window for the writer-level idempotency check. Same vtid+endpoint+
 *  failure_class within this window is treated as a duplicate and skipped.
 *  Sized to comfortably swallow ticker-loop spam (lazyPlanTick fires every
 *  ~30s, multiple Cloud Run instances each run their own ticker) without
 *  hiding a genuine new occurrence after the underlying problem returns. */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Best-effort write — caller must NOT block on the result. A failure to
 * write to self_healing_log is logged but never propagates because that
 * would mask the original autopilot failure that needed surfacing.
 *
 * Idempotency: enforced at the writer (VTID-01971). Before each INSERT we
 * GET self_healing_log filtered by (vtid, endpoint, failure_class) within
 * the last DEDUP_WINDOW_MS; if a row exists, the write is skipped. Stops
 * tick-loop spam (lazyPlanTick re-firing the same plan_gen failure every
 * ~30s × N Cloud Run instances) from flooding the Self-Healing UI with
 * dozens of identical rows. Retries that legitimately need a separate row
 * should pass a stage-discriminating endpoint or distinct failure_class.
 */
export async function writeAutopilotFailure(
  s: SupaConfig,
  args: AutopilotFailureArgs,
): Promise<void> {
  const outcome = args.outcome || 'failed';
  const confidence = args.confidence ?? 0;
  const attempt = args.attempt_number ?? 1;
  try {
    const sinceIso = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const dedupQuery =
      `?vtid=eq.${encodeURIComponent(args.vtid)}` +
      `&endpoint=eq.${encodeURIComponent(args.endpoint)}` +
      `&failure_class=eq.${encodeURIComponent(args.failure_class)}` +
      `&created_at=gte.${encodeURIComponent(sinceIso)}` +
      `&select=id&limit=1`;
    const dedupRes = await fetch(`${s.url}/rest/v1/self_healing_log${dedupQuery}`, {
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
      },
    });
    if (dedupRes.ok) {
      const existing = (await dedupRes.json()) as Array<{ id: string }>;
      if (Array.isArray(existing) && existing.length > 0) {
        return;
      }
    }

    const res = await fetch(`${s.url}/rest/v1/self_healing_log`, {
      method: 'POST',
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        vtid: args.vtid,
        endpoint: args.endpoint,
        failure_class: args.failure_class,
        confidence,
        diagnosis: { stage: args.stage, ...args.diagnosis },
        outcome,
        attempt_number: attempt,
        resolved_at: outcome === 'pending' ? null : new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`${LOG_PREFIX} self_healing_log POST failed (${res.status}): ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} self_healing_log POST threw:`, err);
  }
}

/**
 * Detect the worker spawn error pattern that's been silently failing plan
 * generation: `failed to spawn ...claude... ENOENT`. When the worker can't
 * find the Claude Code binary, the gateway should fall back to direct
 * Messages API (when ANTHROPIC_API_KEY is set) instead of escalating.
 */
export function isWorkerBinaryMissing(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  return /spawn .*claude.*ENOENT|Is Claude Code installed and on PATH/i.test(errorMessage);
}
