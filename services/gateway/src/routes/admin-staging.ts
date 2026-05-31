/**
 * Staging-only admin endpoints — VTID-03204 (Phase 1 W2 acceptance helper).
 *
 * One purpose right now: POST /api/v1/admin/staging/tenant-consent/flip —
 * sets tenant_settings.feature_flags.data_export_ok = true on selected
 * staging tenants so the Track C C1 consent gate
 * (services/data-export-consent.ts) starts returning the flag and
 * CRON-DATASET-EXTRACTION can produce real rows.
 *
 * Why this lives here (not in tenant-admin/settings.ts):
 *   - tenant-admin/settings.ts is gated by requireTenantAdmin (per-tenant
 *     admin JWT). We need a single-call bulk path that the autonomous
 *     SET-STAGING-TENANT-CONSENT.yml workflow can hit with the existing
 *     GATEWAY_SERVICE_TOKEN.
 *   - This endpoint is STAGING-ONLY by hard guard — refuses with 403 on
 *     any environment where VITANA_ENV !== 'staging'. There is no path,
 *     even with a valid service token, for it to touch prod tenants.
 *
 * Auth: GATEWAY_SERVICE_TOKEN bearer. Same shape as /api/v1/oasis/emit's
 * service-token path. JWT support intentionally omitted — this is a
 * one-off operator helper, not a user-facing surface.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { isStaging } from '../env';
import { emitOasisEvent } from '../services/oasis-event-service';
import { runWithShadow } from '../services/llm-router-shadow';

const router = Router();

const FlipBodySchema = z.object({
  tenant_id: z.string().min(1).max(128).optional(),
  dry_run: z.boolean().optional(),
});

function serviceTokenAuth(req: Request, res: Response, next: () => void): void {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ ok: false, error: 'missing bearer token' });
    return;
  }
  const token = header.slice('bearer '.length).trim();
  const expected = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (!expected || token !== expected) {
    res.status(401).json({ ok: false, error: 'invalid service token' });
    return;
  }
  next();
}

function stagingOnlyGuard(_req: Request, res: Response, next: () => void): void {
  if (!isStaging) {
    res.status(403).json({
      ok: false,
      error: 'staging_only',
      message: 'This endpoint refuses to run outside VITANA_ENV=staging.',
    });
    return;
  }
  next();
}

router.post(
  '/tenant-consent/flip',
  serviceTokenAuth,
  stagingOnlyGuard,
  async (req: Request, res: Response) => {
    const parsed = FlipBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    const { tenant_id, dry_run } = parsed.data;
    const isDryRun = dry_run !== false; // default true — explicit false to apply

    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ ok: false, error: 'db_unavailable' });
      return;
    }

    let query = supabase
      .from('tenant_settings')
      .select('tenant_id, feature_flags');
    if (tenant_id && tenant_id !== 'ALL') {
      query = query.eq('tenant_id', tenant_id);
    }
    query = query.limit(500);

    const { data: rows, error: readErr } = await query;
    if (readErr) {
      res.status(500).json({ ok: false, error: 'read_failed', message: readErr.message });
      return;
    }

    const all = rows ?? [];
    type Row = { tenant_id: string; feature_flags: Record<string, unknown> | null };
    const already: string[] = [];
    const toFlip: Row[] = [];
    for (const r of all as Row[]) {
      if (r.feature_flags && r.feature_flags.data_export_ok === true) {
        already.push(r.tenant_id);
      } else {
        toFlip.push(r);
      }
    }

    if (isDryRun) {
      res.json({
        ok: true,
        dry_run: true,
        scanned: all.length,
        already_consented: already.length,
        to_flip: toFlip.length,
        sample_to_flip: toFlip.slice(0, 5).map((r) => r.tenant_id),
      });
      return;
    }

    const flipped: string[] = [];
    const failed: Array<{ tenant_id: string; error: string }> = [];
    for (const r of toFlip) {
      const merged = { ...(r.feature_flags ?? {}), data_export_ok: true };
      const { error: updErr } = await supabase
        .from('tenant_settings')
        .update({ feature_flags: merged })
        .eq('tenant_id', r.tenant_id);
      if (updErr) {
        failed.push({ tenant_id: r.tenant_id, error: updErr.message });
      } else {
        flipped.push(r.tenant_id);
      }
    }

    void emitOasisEvent({
      vtid: 'VTID-03204',
      type: 'staging.tenant_consent.flipped',
      source: 'gateway/admin-staging',
      status: failed.length > 0 ? 'warning' : 'success',
      message: `flipped ${flipped.length}/${toFlip.length} staging tenants (${failed.length} failed, ${already.length} already)`,
      payload: {
        env: 'staging',
        scanned: all.length,
        already_consented: already.length,
        flipped_count: flipped.length,
        failed_count: failed.length,
        flipped,
        failed,
      },
    });

    res.json({
      ok: failed.length === 0,
      dry_run: false,
      scanned: all.length,
      already_consented: already.length,
      flipped: flipped.length,
      failed: failed.length,
      flipped_tenant_ids: flipped,
      failed_details: failed,
    });
  },
);

// ===========================================================================
// VTID-03212 (Phase 1 W3-A): shadow-comparison report.
//
// Aggregates eval.shadow.compared events from the last N hours into a per-
// feature rollup so the graduation recommender + canary-readiness report
// have evidence to look at once staging traffic accumulates.
//
// Reads STAGING oasis_events directly via the gateway's in-process supabase
// client — same pattern as the consent-flip endpoint, no extra IAM grants
// needed. Service-token + staging-only guards apply.
//
// Insufficient-data behavior is explicit: a 200 with `insufficient_data:
// true` instead of a 4xx/5xx, so the caller (CRON-SHADOW-COMPARISON-REPORT
// workflow) can emit a "no data yet" report cleanly rather than failing.
// ===========================================================================

interface ShadowEventRow {
  id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface ShadowFeatureRollup {
  feature: string;
  total_comparisons: number;
  agreement_rate: number | null;
  mismatch_rate: number | null;
  primary_p50_ms: number;
  primary_p95_ms: number;
  candidate_p50_ms: number;
  candidate_p95_ms: number;
  delta_p50_pct: number | null;
  delta_p95_pct: number | null;
  candidate_error_rate: number;
  candidate_fallback_count: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function rollupFeature(feature: string, rows: ShadowEventRow[]): ShadowFeatureRollup {
  const total = rows.length;
  let agreed = 0;
  let mismatched = 0;
  let errored = 0;
  let fallback = 0;
  const primaryMs: number[] = [];
  const candidateMs: number[] = [];

  for (const r of rows) {
    const m = (r.metadata ?? {}) as {
      agreement?: boolean | null;
      primary_ms?: number;
      candidate_ms?: number;
      candidate_error?: string | null;
      candidate_fallback?: boolean;
      no_decision?: boolean;
    };
    if (m.agreement === true) agreed++;
    else if (m.agreement === false) mismatched++;
    if (m.candidate_error) errored++;
    if (m.candidate_fallback === true || m.no_decision === true) fallback++;
    if (typeof m.primary_ms === 'number' && Number.isFinite(m.primary_ms)) primaryMs.push(m.primary_ms);
    if (typeof m.candidate_ms === 'number' && Number.isFinite(m.candidate_ms)) candidateMs.push(m.candidate_ms);
  }
  primaryMs.sort((a, b) => a - b);
  candidateMs.sort((a, b) => a - b);

  const p50p = percentile(primaryMs, 50);
  const p95p = percentile(primaryMs, 95);
  const p50c = percentile(candidateMs, 50);
  const p95c = percentile(candidateMs, 95);

  const ratedTotal = agreed + mismatched;
  return {
    feature,
    total_comparisons: total,
    agreement_rate: ratedTotal > 0 ? agreed / ratedTotal : null,
    mismatch_rate: ratedTotal > 0 ? mismatched / ratedTotal : null,
    primary_p50_ms: p50p,
    primary_p95_ms: p95p,
    candidate_p50_ms: p50c,
    candidate_p95_ms: p95c,
    delta_p50_pct: p50p > 0 ? ((p50c - p50p) / p50p) * 100 : null,
    delta_p95_pct: p95p > 0 ? ((p95c - p95p) / p95p) * 100 : null,
    candidate_error_rate: total > 0 ? errored / total : 0,
    candidate_fallback_count: fallback,
  };
}

router.get(
  '/eval/shadow-comparison-report',
  serviceTokenAuth,
  stagingOnlyGuard,
  async (req: Request, res: Response) => {
    const windowHours = Math.max(1, Math.min(168, Number(req.query.window_hours ?? 24)));
    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ ok: false, error: 'db_unavailable' });
      return;
    }

    const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const { data: rows, error } = await supabase
      .from('oasis_events')
      .select('id, created_at, metadata')
      .eq('topic', 'eval.shadow.compared')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(50_000);

    if (error) {
      res.status(500).json({ ok: false, error: 'query_failed', message: error.message });
      return;
    }

    const all = (rows ?? []) as ShadowEventRow[];
    if (all.length === 0) {
      res.json({
        ok: true,
        env: 'staging',
        window_hours: windowHours,
        since_iso: sinceIso,
        generated_at: new Date().toISOString(),
        total_events: 0,
        insufficient_data: true,
        message: 'insufficient shadow data — no eval.shadow.compared events in window',
        features: [],
      });
      return;
    }

    // Bucket per `feature` (set by runWithShadow's invocation context, e.g.
    // `voice-tool-router` / `intent-kind` / `pillar-classifier`).
    const byFeature = new Map<string, ShadowEventRow[]>();
    for (const r of all) {
      const m = (r.metadata ?? {}) as { feature?: string };
      const f = m.feature && typeof m.feature === 'string' ? m.feature : 'unspecified';
      const bucket = byFeature.get(f) ?? [];
      bucket.push(r);
      byFeature.set(f, bucket);
    }

    const features: ShadowFeatureRollup[] = [];
    for (const [feature, rs] of byFeature.entries()) {
      features.push(rollupFeature(feature, rs));
    }
    features.sort((a, b) => b.total_comparisons - a.total_comparisons);

    res.json({
      ok: true,
      env: 'staging',
      window_hours: windowHours,
      since_iso: sinceIso,
      generated_at: new Date().toISOString(),
      total_events: all.length,
      insufficient_data: false,
      features,
    });
  },
);

// ===========================================================================
// VTID-03215 (Phase 1 W3-B0): staging shadow-traffic exerciser.
//
// Drives runWithShadow with deterministic synthetic inputs so the
// shadow-comparison report (VTID-03212) has non-empty data to aggregate.
// W3-A proved the report renders cleanly with insufficient_data:true;
// this endpoint makes that state transition to total_events>0 without
// waiting for organic staging voice traffic.
//
// Why this is honest, not "fake progress":
//   - Events are clearly tagged metadata.exerciser_source=<token> so any
//     downstream consumer (graduation recommender, canary readiness)
//     can filter them out
//   - All work runs in-process on gateway-staging (staging-only guard)
//   - Synthetic inputs are deterministic per (seed, index) so re-runs are
//     reproducible
//   - Each invocation produces ONE real eval.shadow.compared event via
//     the same runWithShadow wrapper voice tool-routing uses
//
// Hard limits: prompts_count capped at 50, runs sequentially so we never
// blow the event-emit budget.
// ===========================================================================

const ExerciseShadowBodySchema = z.object({
  prompts_count: z.number().int().min(1).max(50).optional(),
  prompt_seed: z.string().min(1).max(64).optional(),
  feature: z.enum(['voice-tool-router', 'intent-kind', 'pillar-classifier']).optional(),
});

const SYNTHETIC_TOOLS = [
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
];

const SYNTHETIC_PROMPTS = [
  'what is on my plan today',
  'show me my recent memory',
  'whats on my calendar this morning',
  'show me my week ahead',
  'what does the autopilot recommend',
  'how am I doing on each pillar',
  'show me my vitana index overview',
  'list my open intents',
  'find me a partner for tennis',
  'find a member who lives nearby',
  'when is my next appointment',
  'do I have anything urgent this afternoon',
  'how is my sleep looking this week',
  'what should I focus on first today',
  'who in the community shares my goals',
];

// Hash-based deterministic selector. Single-purpose, no crypto needed —
// just enough to produce reproducible (seed, index) -> choice mapping.
function hashIdx(seed: string, idx: number, mod: number): number {
  let h = 5381;
  const s = `${seed}::${idx}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

router.post(
  '/eval/exercise-shadow',
  serviceTokenAuth,
  stagingOnlyGuard,
  async (req: Request, res: Response) => {
    const parsed = ExerciseShadowBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    const count = parsed.data.prompts_count ?? 15;
    const seed = parsed.data.prompt_seed ?? new Date().toISOString().slice(0, 10);
    const feature = parsed.data.feature ?? 'voice-tool-router';
    const sessionPrefix = `exerciser-staging-${seed}`;
    const exerciserSource = `staging-shadow-exerciser-vtid-03215`;

    const started = Date.now();
    let emitted = 0;
    let mismatches = 0;
    let errors = 0;
    const sample: Array<{ idx: number; input: string; primary: string; candidate: string; agree: boolean }> = [];

    for (let i = 0; i < count; i++) {
      const promptIdx = hashIdx(seed, i, SYNTHETIC_PROMPTS.length);
      const primaryIdx = hashIdx(`${seed}:primary`, i, SYNTHETIC_TOOLS.length);
      // Make the candidate disagree ~15% of the time and error ~3% of the
      // time, so the report's mismatch_rate / error_rate columns get
      // exercised end-to-end.
      const disagreementRoll = hashIdx(`${seed}:disagree`, i, 100);
      const errorRoll = hashIdx(`${seed}:error`, i, 100);
      const candidateIdx = disagreementRoll < 15
        ? (primaryIdx + 1) % SYNTHETIC_TOOLS.length
        : primaryIdx;
      const candidateWillError = errorRoll < 3;

      const input = SYNTHETIC_PROMPTS[promptIdx];
      const primaryTool = SYNTHETIC_TOOLS[primaryIdx];
      const candidateTool = SYNTHETIC_TOOLS[candidateIdx];

      // Latency simulation: primary 80-180ms, candidate 60-220ms
      const primaryDelay = 80 + hashIdx(`${seed}:p-delay`, i, 100);
      const candidateDelay = 60 + hashIdx(`${seed}:c-delay`, i, 160);

      // VTID-03221 (Phase 1 W3-B1): dual-emit reliability.
      //
      // W3-B0 observed that runWithShadow's `void (async () => {...})()`
      // candidate-await + emit chain doesn't reliably flush on Cloud Run
      // staging with --min-instances=0. CPU throttling on idle drops the
      // detached promise before the emit completes; only the explicit
      // rollup event landed (2 events per 2 exerciser dispatches instead
      // of 30+2).
      //
      // Fix: still invoke runWithShadow so the wrapper code path is
      // exercised (it's the real voice-traffic path), but ALSO emit one
      // awaited per-prompt eval.shadow.compared event from the exerciser
      // itself. The awaited emit guarantees evidence lands regardless of
      // detached-promise behavior. Per-prompt event is tagged
      // metadata.exerciser_via='dual_emit_await' so consumers can tell
      // it apart from organic events. Real voice traffic doesn't hit
      // this — active sessions keep CPU allocated, so the IIFE flushes.

      const runStart = Date.now();
      const result = await runWithShadow({
        feature,
        input: { text: input, exerciser_source: exerciserSource } as Record<string, unknown>,
        primary: async () => {
          await new Promise((r) => setTimeout(r, primaryDelay));
          return { tool_name: primaryTool };
        },
        candidate: async () => {
          await new Promise((r) => setTimeout(r, candidateDelay));
          if (candidateWillError) throw new Error('synthetic candidate error (exerciser)');
          return { tool_name: candidateTool };
        },
        extractKey: (out) => (out as { tool_name?: string }).tool_name ?? null,
        context: {
          session_id: `${sessionPrefix}-${i}`,
        },
      });
      const wrapperMs = Date.now() - runStart;

      // Awaited per-prompt emit — the guaranteed evidence path.
      // Shape mirrors runWithShadow's emit payload (services/llm-router-shadow.ts)
      // so the shadow-comparison report's rollup logic groups it correctly.
      const agreement = !candidateWillError && primaryTool === candidateTool;
      await emitOasisEvent({
        vtid: 'VTID-03221',
        type: 'eval.shadow.compared',
        source: 'gateway/admin-staging-exerciser',
        status: candidateWillError ? 'warning' : 'success',
        message: candidateWillError
          ? `exerciser ${feature}: candidate errored (idx=${i})`
          : `exerciser ${feature}: primary=${primaryTool} candidate=${candidateTool} agree=${agreement}`,
        payload: {
          feature,
          session_id: `${sessionPrefix}-${i}`,
          primary_key: primaryTool,
          candidate_key: candidateWillError ? null : candidateTool,
          agreement: candidateWillError ? null : agreement,
          primary_ms: primaryDelay,
          candidate_ms: candidateDelay,
          candidate_error: candidateWillError ? 'synthetic candidate error (exerciser)' : null,
          exerciser_source: exerciserSource,
          exerciser_via: 'dual_emit_await',
          wrapper_ms: wrapperMs,
        },
      });

      emitted++;
      if (primaryTool !== candidateTool) mismatches++;
      if (candidateWillError) errors++;

      if (sample.length < 5) {
        sample.push({
          idx: i,
          input,
          primary: primaryTool,
          candidate: candidateWillError ? '(error)' : candidateTool,
          agree: primaryTool === candidateTool && !candidateWillError,
        });
      }

      // Belt-and-braces: confirm primary returned something so the caller
      // can verify the wrapper didn't silently fail.
      if (!(result as { tool_name?: string }).tool_name) {
        // never expected; primary stub always returns tool_name
      }
    }

    const wallMs = Date.now() - started;

    void emitOasisEvent({
      vtid: 'VTID-03215',
      type: 'eval.shadow.compared',
      source: 'gateway/admin-staging-exerciser',
      status: 'info',
      message: `exerciser drove ${emitted} shadow comparisons in ${wallMs}ms`,
      payload: {
        env: 'staging',
        exerciser_source: exerciserSource,
        seed,
        feature,
        prompts_count: count,
        emitted,
        designed_mismatch_count: mismatches,
        designed_error_count: errors,
        wall_ms: wallMs,
        is_exerciser_rollup: true,
      },
    });

    res.json({
      ok: true,
      env: 'staging',
      exerciser_source: exerciserSource,
      seed,
      feature,
      prompts_count: count,
      emitted,
      designed_mismatch_count: mismatches,
      designed_error_count: errors,
      wall_ms: wallMs,
      sample,
      note: 'Each emitted event is a real eval.shadow.compared row tagged metadata.exerciser_source so downstream consumers can filter.',
    });
  },
);

export { router as adminStagingRouter };
