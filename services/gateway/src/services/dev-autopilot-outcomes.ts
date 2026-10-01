/**
 * Dev Autopilot Outcomes — write-through to the substrate that records
 * every approve / auto-exec / reject / dismiss decision and the eventual
 * execution outcome.
 *
 * The dev_autopilot_outcomes table is the data substrate the future
 * autonomy-graduation policy reads to decide which scanners earn a higher
 * autonomy level (e.g., "scanner X had 50 consecutive successful auto_exec
 * outcomes — promote it to full_auto"). For now we just *record*; the
 * policy that *acts* on these rows is a follow-up.
 *
 * Failures here are logged and swallowed — never break the user-facing
 * action because the substrate write failed.
 */

import { isExecutableSourceType } from './autopilot-executable-source-types';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const LOG_PREFIX = '[dev-autopilot-outcomes]';

export type OutcomeDecision = 'auto_exec' | 'approved' | 'rejected' | 'dismissed' | 'demoted';
export type ExecOutcome = 'success' | 'failure' | 'rolled_back' | 'timeout';

interface SupaConfig {
  url: string;
  key: string;
}

function getSupa(): SupaConfig | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  return { url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE };
}

interface FindingShape {
  /** Free text on the row; gated below by the executor-lane allowlist. */
  source_type: string | null;
  risk_class: string | null;
  impact_score: number | null;
  effort_score: number | null;
  spec_snapshot: { scanner?: string } | null;
}

async function fetchFinding(supa: SupaConfig, findingId: string): Promise<FindingShape | null> {
  try {
    const r = await fetch(
      `${supa.url}/rest/v1/autopilot_recommendations` +
        `?id=eq.${findingId}` +
        `&select=source_type,risk_class,impact_score,effort_score,spec_snapshot` +
        `&limit=1`,
      { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` } },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as FindingShape[];
    return rows[0] || null;
  } catch {
    return null;
  }
}

export interface RecordOutcomeInput {
  finding_id: string;
  decision: OutcomeDecision;
  approver_user_id?: string | null;
  vtid?: string | null;
  human_modified_plan?: boolean;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a new outcome row at the moment of decision. Idempotent in spirit:
 * a finding can have multiple outcome rows over its lifetime (e.g., an
 * auto_exec that fails → demoted → eventually approved by a human). Each
 * row represents one decision.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
  const supa = getSupa();
  if (!supa) return;

  const finding = await fetchFinding(supa, input.finding_id);
  if (!finding) {
    // Finding gone — silently skip. Outcomes exist only for findings that
    // can enter the executor lane.
    return;
  }
  // VTID-03844: gate on the SAME allowlist the executor lane uses
  // (autopilot-executable-source-types.ts) instead of a hard-coded pair.
  // The old `dev_autopilot` / `dev_autopilot_impact` check silently dropped
  // every operator on-ramp execution (source_type `operator_onramp`,
  // VTID-03820) — observed on staging 2026-09-13: zero outcome rows for a
  // real approved+executed on-ramp finding. Non-executable source_types
  // (user-facing recommendations) still skip. The table's CHECK constraint
  // is widened to the same list by migration
  // 20260913100000_vtid_03844_outcomes_source_type_allowlist.sql.
  if (!isExecutableSourceType(finding.source_type)) {
    return;
  }

  const scanner_name = (finding.spec_snapshot?.scanner as string) || 'unknown';

  try {
    const r = await fetch(`${supa.url}/rest/v1/dev_autopilot_outcomes`, {
      method: 'POST',
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        finding_id: input.finding_id,
        scanner_name,
        source_type: finding.source_type,
        risk_class: finding.risk_class,
        impact_score: finding.impact_score,
        effort_score: finding.effort_score,
        decision: input.decision,
        approver_user_id: input.approver_user_id ?? null,
        vtid: input.vtid ?? null,
        human_modified_plan: input.human_modified_plan ?? false,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`${LOG_PREFIX} insert failed (${r.status}): ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} insert error:`, err);
  }
}

/**
 * Backfill the exec_outcome on the most recent outcome row for a finding
 * after the worker reports completion/failure. There is normally a single
 * "open" outcome row per finding (the most recent decision='approved' or
 * 'auto_exec' with exec_outcome IS NULL); this updates that one.
 *
 * If no open outcome row exists (e.g., finding was approved before this
 * substrate shipped, or the approval-time write failed), this is a no-op —
 * we don't fabricate history.
 */
export async function recordExecOutcome(
  finding_id: string,
  exec_outcome: ExecOutcome,
  vtid?: string | null,
): Promise<void> {
  const supa = getSupa();
  if (!supa) return;

  // Find the latest open outcome row for this finding.
  const findUrl =
    `${supa.url}/rest/v1/dev_autopilot_outcomes` +
    `?finding_id=eq.${finding_id}` +
    `&decision=in.(approved,auto_exec)` +
    `&exec_outcome=is.null` +
    `&order=created_at.desc&limit=1` +
    `&select=id`;

  try {
    const findR = await fetch(findUrl, {
      headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` },
    });
    if (!findR.ok) return;
    const rows = (await findR.json()) as Array<{ id: string }>;
    const target = rows[0];
    if (!target) return;

    const patchR = await fetch(`${supa.url}/rest/v1/dev_autopilot_outcomes?id=eq.${target.id}`, {
      method: 'PATCH',
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        exec_outcome,
        exec_completed_at: new Date().toISOString(),
        ...(vtid ? { vtid } : {}),
      }),
    });
    if (!patchR.ok) {
      const body = await patchR.text();
      console.warn(`${LOG_PREFIX} backfill failed (${patchR.status}): ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} backfill error:`, err);
  }
}

/**
 * VTID-04017: per-run usage/cost of an agent execution, appended to the
 * finding's latest outcome row (`metadata.agent_runs[]`) so cost per run
 * is readable next to the decision and the exec outcome without a schema
 * change. Best-effort like everything else in this module.
 */
export interface AgentRunUsage {
  execution_id: string;
  vtid: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
  fix_rounds: number;
  checks_refused: number;
  fallback_used: boolean;
  fix_mode: boolean;
  // VTID-04029: 'awaiting_approval' — the branch was pushed and the run
  // stopped before opening a PR, waiting for a human Approve/Reject.
  outcome: 'pr_opened' | 'fix_pushed' | 'awaiting_approval' | 'failed' | 'cancelled';
  error?: string | null;
  elapsed_ms: number;
  recorded_at: string;
}

export function appendAgentRun(existing: unknown, run: AgentRunUsage, cap = 20): Record<string, unknown> {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const prior = Array.isArray(base.agent_runs) ? (base.agent_runs as unknown[]) : [];
  const runs = [...prior.filter((r) => !(r && typeof r === 'object' && (r as { execution_id?: string }).execution_id === run.execution_id)), run];
  base.agent_runs = runs.slice(-cap);
  const total = runs.reduce<number>((sum, r) => sum + (Number((r as { cost_usd?: number }).cost_usd) || 0), 0);
  base.agent_cost_usd_total = Math.round(total * 1_000_000) / 1_000_000;
  return base;
}

/**
 * VTID-04267: Dev Autopilot spend surfacing. The Command Hub Dev Autopilot
 * panel showed a "Budget: —/N today" chip that never resolved past the
 * dash — no endpoint ever computed real spend, only the daily
 * APPROVAL-COUNT budget (a separate axis, see dev-autopilot-safety.ts's
 * daily_budget). The real per-run cost is already recorded (agent_runs[]
 * above), just never aggregated into a "today" figure anywhere.
 *
 * dev_autopilot_outcomes has no `updated_at` column (a PATCH that appends
 * a run does not change `created_at`), so "today's spend" can't be a
 * server-side date-filtered query — callers fetch a bounded recent window
 * of rows and this pure function sums whichever `agent_runs[]` entries
 * actually carry a `recorded_at` from today (UTC), regardless of which
 * row they live on. Pure and unit-testable independent of Supabase.
 */
export interface SpendSummary {
  spend_usd_today: number;
  input_tokens_today: number;
  output_tokens_today: number;
  runs_today: number;
}

export function summarizeSpendToday(
  outcomeRows: Array<{ metadata: unknown }>,
  now: Date = new Date(),
): SpendSummary {
  const todayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let spend = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let runs = 0;
  for (const row of outcomeRows) {
    const meta = row && typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
    const agentRuns = Array.isArray(meta.agent_runs) ? (meta.agent_runs as unknown[]) : [];
    for (const raw of agentRuns) {
      if (!raw || typeof raw !== 'object') continue;
      const run = raw as Partial<AgentRunUsage>;
      const recordedAtMs = typeof run.recorded_at === 'string' ? Date.parse(run.recorded_at) : NaN;
      if (Number.isNaN(recordedAtMs) || recordedAtMs < todayStartUtc) continue;
      spend += Number(run.cost_usd) || 0;
      inputTokens += Number(run.input_tokens) || 0;
      outputTokens += Number(run.output_tokens) || 0;
      runs += 1;
    }
  }
  return {
    spend_usd_today: Math.round(spend * 1_000_000) / 1_000_000,
    input_tokens_today: inputTokens,
    output_tokens_today: outputTokens,
    runs_today: runs,
  };
}

export async function recordAgentRunUsage(finding_id: string, run: AgentRunUsage): Promise<void> {
  const supa = getSupa();
  if (!supa) return;
  const findUrl =
    `${supa.url}/rest/v1/dev_autopilot_outcomes` +
    `?finding_id=eq.${finding_id}` +
    `&order=created_at.desc&limit=1` +
    `&select=id,metadata`;
  try {
    const findR = await fetch(findUrl, { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` } });
    if (!findR.ok) return;
    const rows = (await findR.json()) as Array<{ id: string; metadata: unknown }>;
    const target = rows[0];
    if (!target) return;
    const patchR = await fetch(`${supa.url}/rest/v1/dev_autopilot_outcomes?id=eq.${target.id}`, {
      method: 'PATCH',
      headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: appendAgentRun(target.metadata, run) }),
    });
    if (!patchR.ok) console.warn(`${LOG_PREFIX} agent usage record failed (${patchR.status}): ${(await patchR.text()).slice(0, 200)}`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} agent usage record error:`, err);
  }
}

