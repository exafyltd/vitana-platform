/**
 * Developer Autopilot — Synthesis service (Stage A: ingest + dedup + rank)
 *
 * Takes raw signals from the scanner workflow and produces findings in
 * autopilot_recommendations with source_type='dev_autopilot'. Dedups by
 * fingerprint: repeat signals bump seen_count + last_seen_at on the existing
 * row rather than inserting a duplicate.
 *
 * PR-2 ships deterministic rule-based ranking. PR-3 layers a Managed Agent
 * planning stage on top (Stage B) — synthesis here is the data plumbing
 * that both stages share.
 */

import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[dev-autopilot-synthesis]';
const SCAN_VTID = 'VTID-DEV-AUTOPILOT';

// =============================================================================
// Types
// =============================================================================

export type SignalType =
  | 'todo'
  | 'large_file'
  | 'missing_tests'
  | 'dead_code'
  | 'duplication'
  | 'missing_docs'
  | 'circular_dep'
  | 'unused_dep'
  | 'cognitive_complexity'
  | 'safety_gap';

export type Severity = 'low' | 'medium' | 'high';

export interface DevAutopilotSignal {
  type: SignalType;
  severity: Severity;
  file_path: string;
  line_number?: number;
  message: string;
  suggested_action: string;
  scanner?: string;
  raw?: Record<string, unknown>;
}

export interface ScanInput {
  triggered_by?: string;
  signals: DevAutopilotSignal[];
  metadata?: Record<string, unknown>;
}

export interface ScanResult {
  ok: boolean;
  run_id?: string;
  signal_count?: number;
  new_finding_count?: number;
  updated_finding_count?: number;
  error?: string;
}

interface FindingRow {
  id: string;
  signal_fingerprint: string | null;
  seen_count: number | null;
  last_seen_at: string | null;
  status: string;
}

// =============================================================================
// Supabase helpers
// =============================================================================

interface SupaConfig {
  url: string;
  key: string;
}

function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.error(`${LOG_PREFIX} missing SUPABASE_URL or SUPABASE_SERVICE_ROLE`);
    return null;
  }
  return { url, key };
}

async function supaRequest<T>(
  supa: SupaConfig,
  path: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; data?: T; status: number; error?: string }> {
  const headers = {
    apikey: supa.key,
    Authorization: `Bearer ${supa.key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${supa.url}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, status: res.status, error: body };
    }
    if (res.status === 204 || res.status === 201) {
      // Prefer: return=minimal produces 201 with an empty body — don't parse.
      const text = await res.text();
      if (!text) return { ok: true, status: res.status };
      try {
        return { ok: true, data: JSON.parse(text) as T, status: res.status };
      } catch { return { ok: true, status: res.status }; }
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
}

// =============================================================================
// Fingerprinting (matches codebase-analyzer.ts semantics)
// =============================================================================

export function fingerprintSignal(signal: DevAutopilotSignal): string {
  const data = `dev_autopilot:${signal.type}:${signal.file_path}:${signal.line_number ?? 0}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}

// =============================================================================
// Priority scoring (deterministic — PR-2 Stage A)
// =============================================================================

/** Maps severity to impact (1–10). Tuned so high > medium > low roughly 2x apart. */
const SEVERITY_IMPACT: Record<Severity, number> = { low: 3, medium: 6, high: 8 };

/** Effort estimate per signal type (1–10, lower is easier). */
const TYPE_EFFORT: Record<SignalType, number> = {
  dead_code: 2,
  unused_dep: 2,
  todo: 3,
  missing_docs: 3,
  missing_tests: 4,
  circular_dep: 5,
  duplication: 5,
  cognitive_complexity: 6,
  large_file: 7,
  // safety_gap items are infra-scoped integration tests — usually
  // ~half a day of work per gap.
  safety_gap: 6,
};

/** Risk class for auto-exec eligibility — dead_code, unused_dep, missing_docs
 *  are safe refactors; large_file and duplication touch more surface area.
 */
const TYPE_RISK_CLASS: Record<SignalType, 'low' | 'medium' | 'high'> = {
  dead_code: 'low',
  unused_dep: 'low',
  missing_docs: 'low',
  todo: 'medium',
  missing_tests: 'medium',
  circular_dep: 'medium',
  duplication: 'medium',
  cognitive_complexity: 'medium',
  large_file: 'high',
  safety_gap: 'medium',
};

function scoreSignal(signal: DevAutopilotSignal): {
  impact_score: number;
  effort_score: number;
  risk_class: 'low' | 'medium' | 'high';
  auto_exec_eligible: boolean;
} {
  const impact = SEVERITY_IMPACT[signal.severity];
  const effort = TYPE_EFFORT[signal.type];
  const risk = TYPE_RISK_CLASS[signal.type];
  return {
    impact_score: impact,
    effort_score: effort,
    risk_class: risk,
    auto_exec_eligible: risk !== 'high',
  };
}

function titleForSignal(signal: DevAutopilotSignal): string {
  const base = signal.file_path.split('/').pop() || signal.file_path;
  switch (signal.type) {
    case 'dead_code':     return `Remove dead code in ${base}`;
    case 'unused_dep':    return `Remove unused dependency (${base})`;
    case 'todo':          return `Address TODO/FIXME in ${base}`;
    case 'large_file':    return `Refactor large file ${base}`;
    case 'missing_tests': return `Add missing tests for ${base}`;
    case 'duplication':   return `Deduplicate code in ${base}`;
    case 'missing_docs':  return `Add missing docs for ${base}`;
    case 'circular_dep':  return `Break circular dependency via ${base}`;
    case 'cognitive_complexity': return `Reduce cognitive complexity in ${base}`;
    case 'safety_gap':    return signal.message.slice(0, 80);
    default:              return signal.message.substring(0, 80);
  }
}

function domainForPath(path: string): string {
  if (path.startsWith('services/gateway/src/routes/'))   return 'routes';
  if (path.startsWith('services/gateway/src/services/')) return 'services';
  if (path.startsWith('services/gateway/src/frontend/')) return 'frontend';
  if (path.startsWith('services/gateway/src/types/'))    return 'types';
  if (path.startsWith('services/agents/'))               return 'agents';
  if (path.startsWith('supabase/'))                      return 'database';
  return 'general';
}

// =============================================================================
// Core: ingest a scan — dedup + upsert findings
// =============================================================================

export async function ingestScan(input: ScanInput): Promise<ScanResult> {
  const supa = getSupabase();
  if (!supa) return { ok: false, error: 'Gateway misconfigured: Supabase credentials missing' };

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // 1. Create run row
  const runCreate = await supaRequest(supa, '/rest/v1/dev_autopilot_runs', {
    method: 'POST',
    body: JSON.stringify({
      run_id: runId,
      started_at: startedAt,
      status: 'ingesting',
      signal_count: input.signals.length,
      triggered_by: input.triggered_by || 'api',
      metadata: input.metadata || {},
    }),
  });
  if (!runCreate.ok) {
    return { ok: false, error: `run insert failed: ${runCreate.error}` };
  }

  await emitOasisEvent({
    vtid: SCAN_VTID,
    type: 'dev_autopilot.scan.started',
    source: 'dev-autopilot',
    status: 'info',
    message: `Dev Autopilot scan ${runId.slice(0, 8)} started with ${input.signals.length} signals`,
    payload: { run_id: runId, signal_count: input.signals.length, triggered_by: input.triggered_by },
  });

  // 2. Persist raw signals (for audit + dedup traceability)
  if (input.signals.length > 0) {
    const signalRows = input.signals.map(s => ({
      run_id: runId,
      type: s.type,
      severity: s.severity,
      file_path: s.file_path,
      line_number: s.line_number ?? null,
      message: s.message,
      suggested_action: s.suggested_action,
      fingerprint: fingerprintSignal(s),
      scanner: s.scanner ?? null,
      raw: s.raw ?? {},
    }));
    const sigInsert = await supaRequest(supa, '/rest/v1/dev_autopilot_signals', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(signalRows),
    });
    if (!sigInsert.ok) {
      console.warn(`${LOG_PREFIX} signals insert failed (non-fatal): ${sigInsert.error}`);
    }
  }

  // 3. Dedup + upsert findings
  let newCount = 0;
  let updatedCount = 0;
  const now = new Date().toISOString();

  for (const signal of input.signals) {
    const fingerprint = fingerprintSignal(signal);
    // Lookup existing live finding with this fingerprint
    const existing = await supaRequest<FindingRow[]>(
      supa,
      `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&signal_fingerprint=eq.${fingerprint}&status=in.(new,snoozed)&select=id,seen_count,last_seen_at,status&limit=1`,
    );
    if (!existing.ok) {
      console.warn(`${LOG_PREFIX} lookup failed for ${fingerprint}: ${existing.error}`);
      continue;
    }
    const hit = (existing.data || [])[0];
    if (hit) {
      // Bump seen_count + last_seen_at
      const bumped = await supaRequest(supa, `/rest/v1/autopilot_recommendations?id=eq.${hit.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          seen_count: (hit.seen_count || 1) + 1,
          last_seen_at: now,
          updated_at: now,
          source_run_id: runId,
        }),
      });
      if (bumped.ok) updatedCount++;
      continue;
    }

    // Insert new finding
    const score = scoreSignal(signal);
    const title = titleForSignal(signal);
    const domain = domainForPath(signal.file_path);
    const inserted = await supaRequest(supa, '/rest/v1/autopilot_recommendations', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        title,
        summary: signal.message,
        domain,
        risk_level: score.risk_class,
        risk_class: score.risk_class,
        impact_score: score.impact_score,
        effort_score: score.effort_score,
        status: 'new',
        source_type: 'dev_autopilot',
        source_run_id: runId,
        auto_exec_eligible: score.auto_exec_eligible,
        signal_fingerprint: fingerprint,
        first_seen_at: now,
        last_seen_at: now,
        seen_count: 1,
        spec_snapshot: {
          signal_type: signal.type,
          file_path: signal.file_path,
          line_number: signal.line_number,
          suggested_action: signal.suggested_action,
          scanner: signal.scanner,
          // Propagate scanner-specific metadata (file_loc for missing_tests,
          // gap_key/expected_test_file for safety_gap, etc.) into the
          // snapshot so downstream consumers (bulk-archive SQL, auto-approve
          // filter) can read them without a separate lookup.
          ...(signal.raw || {}),
        },
      }),
    });
    if (inserted.ok) newCount++;
  }

  // 4. Finalize run
  const completedAt = new Date().toISOString();
  await supaRequest(supa, `/rest/v1/dev_autopilot_runs?run_id=eq.${runId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'done',
      completed_at: completedAt,
      new_finding_count: newCount,
      updated_finding_count: updatedCount,
    }),
  });

  await emitOasisEvent({
    vtid: SCAN_VTID,
    type: 'dev_autopilot.scan.completed',
    source: 'dev-autopilot',
    status: 'success',
    message: `Dev Autopilot scan ${runId.slice(0, 8)}: ${newCount} new, ${updatedCount} updated`,
    payload: { run_id: runId, new: newCount, updated: updatedCount, total_signals: input.signals.length },
  });

  // 5. Eager Stage B — plan the top K new findings so the UI has actionable
  //    cards immediately. Remaining findings get lazy planning on expand/approve.
  //    FIRE-AND-FORGET: each Managed Agent session takes 30-120s. Awaiting K
  //    of them sequentially pushes the /scan POST over Cloud Run's 5-min
  //    request timeout (BOOTSTRAP-SCAN-TIMEOUT). The UI's lazy planner
  //    already handles the case where a finding has no plan yet.
  if (newCount > 0) {
    const eagerK = parseInt(process.env.DEV_AUTOPILOT_EAGER_PLAN_TOP_K || '5', 10);
    if (eagerK > 0) {
      import('./dev-autopilot-planning').then((planning) => {
        return (planning as { eagerlyPlanTopK: (runId: string, k: number) => Promise<{ planned: number; errors: number }> })
          .eagerlyPlanTopK(runId, eagerK);
      }).then((eagerResult) => {
        console.log(`${LOG_PREFIX} eager plan: ${eagerResult.planned} planned, ${eagerResult.errors} errors`);
      }).catch((err) => {
        console.warn(`${LOG_PREFIX} eager planning failed (non-fatal):`, err);
      });
    }
  }

  return {
    ok: true,
    run_id: runId,
    signal_count: input.signals.length,
    new_finding_count: newCount,
    updated_finding_count: updatedCount,
  };
}

// =============================================================================
// Scoring helpers exposed for tests + Stage B (planning)
// =============================================================================

export { scoreSignal, titleForSignal, domainForPath, SEVERITY_IMPACT, TYPE_RISK_CLASS };
export { LOG_PREFIX };
