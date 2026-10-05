/**
 * VTID-04887 — GET /api/v1/ops/pipeline-summary: the autopilot pipeline
 * summary for people (plan A, Phase 4, Q6).
 *
 * The Command Hub Operator Dashboard and Runbook read the pipeline summary
 * (funnel, attention queue, recommendations, success rate). They used to call
 * GET /api/v1/autopilot/pipeline/summary, which sits behind
 * requireServiceToken (routes/autopilot.ts, VTID-03598): a browser can never
 * hold GATEWAY_SERVICE_TOKEN, so every call was a 401 and both screens showed
 * an empty pipeline.
 *
 * This route serves the same body in-process through buildPipelineSummary()
 * (services/pipeline-summary-builder.ts, VTID-04875). No HTTP self-call.
 * Platform exafy_admin only (requireAdminAuth), the same gate as
 * /api/v1/ops/attention. The service-token route stays as it is for machine
 * callers.
 *
 * Read-only. Single-flight plus a 15 s cache per task for successful answers,
 * so two open screens do not each run the builder's 14 queries. A builder
 * error (status 500) is passed through and never cached.
 */

import { Router, Response } from 'express';
import { requireAdminAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { buildPipelineSummary, type PipelineSummaryResult } from '../services/pipeline-summary-builder';

export const PIPELINE_SUMMARY_CACHE_MS = 15_000;

let cached: { at: number; result: PipelineSummaryResult } | null = null;
let inFlight: Promise<PipelineSummaryResult> | null = null;

/** Test hook: forget the cached answer and any pending computation. */
export function resetOpsPipelineSummaryCacheForTests(): void {
  cached = null;
  inFlight = null;
}

async function getSummary(nowMs: number): Promise<{ result: PipelineSummaryResult; cached: boolean }> {
  if (cached && nowMs - cached.at < PIPELINE_SUMMARY_CACHE_MS) {
    return { result: cached.result, cached: true };
  }
  if (!inFlight) {
    inFlight = buildPipelineSummary()
      .then((result) => {
        if (result.status === 200) cached = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return { result: await inFlight, cached: false };
}

const router = Router();

router.get('/', requireAdminAuth, async (_req: AuthenticatedRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { result, cached: fromCache } = await getSummary(Date.now());
    res.setHeader('X-Pipeline-Summary-Cache', fromCache ? 'hit' : 'miss');
    return res.status(result.status).json(result.body);
  } catch (err) {
    // buildPipelineSummary() never throws; this guards the wrapper itself.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ops-pipeline-summary] failed:', message);
    return res.status(500).json({ ok: false, error: 'pipeline_summary_failed' });
  }
});

export default router;
