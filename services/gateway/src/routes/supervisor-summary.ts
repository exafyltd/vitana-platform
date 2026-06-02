/**
 * Supervisor summary — read-only consolidated program-state endpoint
 * (BOOTSTRAP-SUPERVISOR-SUMMARY).
 *
 * One call for the operator/supervisor daily rhythm. Instead of running the
 * five separate eval/cron scripts (phase-gate-status-report,
 * shadow-comparison-report, canary-readiness-report, backlog-drain-plan) or
 * hitting several endpoints, this aggregates the *latest* live state of the
 * autonomous program into one JSON payload:
 *
 *   - dataset       — latest dataset.extraction.completed per target + row counts
 *   - shadow        — eval.shadow.compared event count in the window
 *   - finetune      — latest finetune.training.completed status per target
 *   - canary        — latest production.canary.* lifecycle event
 *   - auto_promote  — latest auto_promote.proposed / .rejected decision
 *   - backlog       — pending dev-autopilot vtid_ledger rows (cleanup backlog size)
 *
 * STRICTLY READ-ONLY. No mutations, no event emission, no workflow dispatch.
 * Every source is a `select` against the gateway's in-process Supabase
 * (oasis_events + vtid_ledger). This route reuses the same topics the program
 * scripts already produce (see services/gateway/scripts/eval/* and
 * services/gateway/src/types/cicd.ts CicdEventType taxonomy) — it does not
 * invent new state.
 *
 * Auth: bearer GATEWAY_SERVICE_TOKEN (same shape as admin-staging).
 *
 * GET /api/v1/supervisor/summary?window_hours=24
 */

import { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { VITANA_ENV } from '../env';

const router = Router();

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

interface OasisEventRow {
  id?: string;
  topic?: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pull the most-recent dataset.extraction.completed event per target and the
 * row count it produced. Mirrors the row-extraction logic used by
 * phase-gate-status-report / canary-readiness-report (metadata.rows_after_dedup
 * with a fallback to metadata.rows).
 */
async function buildDatasetSection(
  supabase: SupabaseClient,
  sinceIso: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('oasis_events')
    .select('id, created_at, metadata')
    .eq('topic', 'dataset.extraction.completed')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return { available: false, error: error.message };

  const rows = (data ?? []) as OasisEventRow[];
  if (rows.length === 0) {
    return { available: true, event_count: 0, latest_per_target: [], total_rows_latest: 0 };
  }

  // Keep the most-recent event per target.
  const latestByTarget = new Map<string, OasisEventRow>();
  for (const r of rows) {
    const target = str((r.metadata ?? {}).target) ?? 'unknown';
    if (!latestByTarget.has(target)) latestByTarget.set(target, r);
  }

  let totalRows = 0;
  const perTarget = [...latestByTarget.entries()].map(([target, ev]) => {
    const m = ev.metadata ?? {};
    const rowCount = num(m.rows_after_dedup) ?? num(m.rows) ?? 0;
    totalRows += rowCount;
    return { target, rows: rowCount, extracted_at: ev.created_at };
  });

  return {
    available: true,
    event_count: rows.length,
    latest_per_target: perTarget,
    total_rows_latest: totalRows,
  };
}

async function buildShadowSection(
  supabase: SupabaseClient,
  sinceIso: string,
): Promise<Record<string, unknown>> {
  const { count, error } = await supabase
    .from('oasis_events')
    .select('id', { count: 'exact', head: true })
    .eq('topic', 'eval.shadow.compared')
    .gte('created_at', sinceIso);
  if (error) return { available: false, error: error.message };
  const total = count ?? 0;
  return {
    available: true,
    compared_events_in_window: total,
    insufficient_data: total === 0,
  };
}

async function buildFinetuneSection(
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  // Latest fine-tune result per target — not window-bounded, because runs are
  // infrequent and the supervisor wants the most recent regardless of age.
  const { data, error } = await supabase
    .from('oasis_events')
    .select('id, created_at, metadata')
    .eq('topic', 'finetune.training.completed')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return { available: false, error: error.message };

  const rows = (data ?? []) as OasisEventRow[];
  if (rows.length === 0) {
    return { available: true, latest_per_target: [], latest: null };
  }

  const latestByTarget = new Map<string, OasisEventRow>();
  for (const r of rows) {
    const target = str((r.metadata ?? {}).target) ?? 'unknown';
    if (!latestByTarget.has(target)) latestByTarget.set(target, r);
  }

  const perTarget = [...latestByTarget.entries()].map(([target, ev]) => {
    const m = ev.metadata ?? {};
    return {
      target,
      status: str(m.status) ?? 'unknown',
      job_id: str(m.job_id),
      completed_at: ev.created_at,
    };
  });

  return {
    available: true,
    latest_per_target: perTarget,
    latest: {
      status: str((rows[0].metadata ?? {}).status) ?? 'unknown',
      completed_at: rows[0].created_at,
    },
  };
}

async function buildCanarySection(
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  // Latest canary lifecycle event across the four production.canary.* topics.
  const topics = [
    'production.canary.requested',
    'production.canary.started',
    'production.canary.promoted',
    'production.canary.aborted',
  ];
  const { data, error } = await supabase
    .from('oasis_events')
    .select('id, topic, created_at, metadata')
    .in('topic', topics)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return { available: false, error: error.message };

  const rows = (data ?? []) as OasisEventRow[];
  if (rows.length === 0) {
    return { available: true, latest_event: null, latest_phase: null };
  }
  const ev = rows[0];
  return {
    available: true,
    latest_event: ev.topic ?? null,
    latest_phase: (ev.topic ?? '').replace('production.canary.', '') || null,
    occurred_at: ev.created_at,
    metadata: ev.metadata ?? {},
  };
}

async function buildAutoPromoteSection(
  supabase: SupabaseClient,
  sinceIso: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('oasis_events')
    .select('id, topic, created_at, metadata')
    .in('topic', ['auto_promote.proposed', 'auto_promote.rejected'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return { available: false, error: error.message };

  const rows = (data ?? []) as OasisEventRow[];
  const proposed = rows.filter((r) => r.topic === 'auto_promote.proposed').length;
  const rejected = rows.filter((r) => r.topic === 'auto_promote.rejected').length;
  const latest = rows[0] ?? null;
  return {
    available: true,
    proposed_in_window: proposed,
    rejected_in_window: rejected,
    latest_decision: latest
      ? {
          decision: (latest.topic ?? '').replace('auto_promote.', '') || null,
          occurred_at: latest.created_at,
          metadata: latest.metadata ?? {},
        }
      : null,
  };
}

async function buildBacklogSection(
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  // Cleanup/backlog size = pending, non-terminal dev-autopilot tasks in the
  // ledger. Read-only count; the actual drain plan is produced by the
  // backlog-drain-plan script (we do not execute or rank here).
  const { count, error } = await supabase
    .from('vtid_ledger')
    .select('vtid', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('is_terminal', false);
  if (error) return { available: false, error: error.message };
  const pending = count ?? 0;
  return {
    available: true,
    pending_tasks: pending,
  };
}

interface SupervisorSummary {
  ok: true;
  data: {
    generated_at: string;
    env: string;
    window_hours: number;
    since_iso: string;
    dataset: Record<string, unknown>;
    shadow: Record<string, unknown>;
    finetune: Record<string, unknown>;
    canary: Record<string, unknown>;
    auto_promote: Record<string, unknown>;
    backlog: Record<string, unknown>;
  };
}

/**
 * Pure aggregation against an injected Supabase client. Exported so tests can
 * exercise the shape/aggregation with a mocked client and no HTTP layer.
 */
async function buildSummary(
  supabase: SupabaseClient,
  windowHours: number,
): Promise<SupervisorSummary> {
  const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const [dataset, shadow, finetune, canary, autoPromote, backlog] = await Promise.all([
    buildDatasetSection(supabase, sinceIso),
    buildShadowSection(supabase, sinceIso),
    buildFinetuneSection(supabase),
    buildCanarySection(supabase),
    buildAutoPromoteSection(supabase, sinceIso),
    buildBacklogSection(supabase),
  ]);
  return {
    ok: true,
    data: {
      generated_at: new Date().toISOString(),
      env: VITANA_ENV,
      window_hours: windowHours,
      since_iso: sinceIso,
      dataset,
      shadow,
      finetune,
      canary,
      auto_promote: autoPromote,
      backlog,
    },
  };
}

router.get(
  '/summary',
  serviceTokenAuth,
  async (req: Request, res: Response) => {
    const windowHours = Math.max(1, Math.min(168, Number(req.query.window_hours ?? 24)));
    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ ok: false, error: 'db_unavailable' });
      return;
    }
    try {
      const summary = await buildSummary(supabase, windowHours);
      res.json(summary);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'summary_failed',
        message: (err as Error).message,
      });
    }
  },
);

export { router as supervisorSummaryRouter, buildSummary };
export type { SupervisorSummary };
