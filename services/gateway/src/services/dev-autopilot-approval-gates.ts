/**
 * VTID-04667 (P4.2–P4.4 of docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md):
 * pure pre-approval gates for AUTONOMOUS approvals only (autoApproveTick).
 * A human Activate never goes through these.
 *
 *   - large_file findings are never auto-executed (a 2,000+ line refactor is
 *     not something an unattended agent lands);
 *   - a per-finding token budget, summed across every agent run recorded on
 *     the finding's dev_autopilot_outcomes rows (metadata.agent_runs[] /
 *     agent_cost_usd_total, VTID-04017) — over budget → snooze 7 d;
 *   - an outage-class failure (VTID-04368's PROVIDER_OUTAGE_RE) never
 *     re-queues the same finding within an hour: the global outage gate lets
 *     one probe execution through per tick, and without a per-finding
 *     cooldown the same finding was that probe every tick (467 executions of
 *     impact:new-env-var-requires-workflow-binding in ~14 h, 22–23 Sept);
 *   - the plan's (non-test, code) files must exist in the codebase index,
 *     checked only when the index loads — never a block on an index outage.
 */
import { isProviderOutageFailure } from './dev-autopilot-retry-breaker';

// ---------------------------------------------------------------- large_file

/** Signal types an unattended agent never executes. */
export const NEVER_AUTO_EXECUTE_SIGNAL_TYPES = ['large_file'] as const;

export function isNeverAutoExecuteSignal(spec: { signal_type?: unknown } | null | undefined): boolean {
  const t = spec && typeof spec === 'object' ? spec.signal_type : null;
  return typeof t === 'string' && (NEVER_AUTO_EXECUTE_SIGNAL_TYPES as readonly string[]).includes(t);
}

// ---------------------------------------------------------------- token budget

export const DEFAULT_FINDING_BUDGET_USD = 3;
export const DEFAULT_FINDING_BUDGET_INPUT_TOKENS = 5_000_000;

export interface FindingBudget { max_cost_usd: number; max_input_tokens: number }

function posNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** DEV_AUTOPILOT_FINDING_BUDGET_USD / DEV_AUTOPILOT_FINDING_BUDGET_INPUT_TOKENS. */
export function resolveFindingBudget(env: NodeJS.ProcessEnv = process.env): FindingBudget {
  return {
    max_cost_usd: posNum(env.DEV_AUTOPILOT_FINDING_BUDGET_USD, DEFAULT_FINDING_BUDGET_USD),
    max_input_tokens: posNum(env.DEV_AUTOPILOT_FINDING_BUDGET_INPUT_TOKENS, DEFAULT_FINDING_BUDGET_INPUT_TOKENS),
  };
}

export interface FindingSpend { cost_usd: number; input_tokens: number; runs: number }

/**
 * Sums every agent run across the finding's outcome rows, deduplicated by
 * execution_id. agent_runs[] is capped at 20 entries per row, so the row's
 * own agent_cost_usd_total is also taken into account (the larger wins).
 */
export interface RecordedAgentRun {
  execution_id: string | null;
  cost_usd: number;
  input_tokens: number;
}

function outcomeMeta(row: { metadata: unknown } | null | undefined): Record<string, unknown> | null {
  return row && row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>) : null;
}

/**
 * Every agent run recorded on the given dev_autopilot_outcomes rows
 * (metadata.agent_runs[], VTID-04017), deduplicated by execution_id.
 * Shared by the per-finding budget below and the VTID-04668 priority score
 * (median cost per execution for a scanner).
 */
export function extractAgentRuns(rows: Array<{ metadata: unknown }> | null | undefined): RecordedAgentRun[] {
  const seen = new Set<string>();
  const out: RecordedAgentRun[] = [];
  for (const row of rows || []) {
    const meta = outcomeMeta(row);
    if (!meta) continue;
    const list = Array.isArray(meta.agent_runs) ? meta.agent_runs : [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as { execution_id?: unknown; cost_usd?: unknown; input_tokens?: unknown };
      const id = typeof r.execution_id === 'string' ? r.execution_id : null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push({ execution_id: id, cost_usd: Number(r.cost_usd) || 0, input_tokens: Number(r.input_tokens) || 0 });
    }
  }
  return out;
}

export function summarizeFindingSpend(rows: Array<{ metadata: unknown }> | null | undefined): FindingSpend {
  let totalsCost = 0;
  for (const row of rows || []) {
    const meta = outcomeMeta(row);
    if (meta) totalsCost += Number(meta.agent_cost_usd_total) || 0;
  }
  const runs = extractAgentRuns(rows);
  const runCost = runs.reduce((s, r) => s + r.cost_usd, 0);
  const tokens = runs.reduce((s, r) => s + r.input_tokens, 0);
  return { cost_usd: Math.round(Math.max(runCost, totalsCost) * 1_000_000) / 1_000_000, input_tokens: tokens, runs: runs.length };
}

export function isOverFindingBudget(spend: FindingSpend, budget: FindingBudget = resolveFindingBudget()): boolean {
  return spend.cost_usd >= budget.max_cost_usd || spend.input_tokens >= budget.max_input_tokens;
}

// ---------------------------------------------------------------- outage requeue cap

export const DEFAULT_OUTAGE_REQUEUE_COOLDOWN_MS = 60 * 60 * 1000;

/** DEV_AUTOPILOT_OUTAGE_REQUEUE_MINUTES overrides the 60-minute cooldown. */
export function resolveOutageRequeueCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  return posNum(env.DEV_AUTOPILOT_OUTAGE_REQUEUE_MINUTES, DEFAULT_OUTAGE_REQUEUE_COOLDOWN_MS / 60000) * 60000;
}

const TERMINAL_FAILURE = new Set(['failed', 'failed_escalated', 'reverted']);

/**
 * True when the finding's newest execution failed with an outage-class error
 * less than `cooldownMs` ago — do not re-approve it yet.
 */
export function inOutageRequeueCooldown(
  latest: { status: string; updated_at: string; metadata?: Record<string, unknown> | null } | null | undefined,
  nowMs: number = Date.now(),
  cooldownMs: number = resolveOutageRequeueCooldownMs(),
): boolean {
  if (!latest || !TERMINAL_FAILURE.has(latest.status)) return false;
  if (!isProviderOutageFailure(latest.metadata)) return false;
  const t = Date.parse(latest.updated_at);
  return Number.isFinite(t) && nowMs - t < cooldownMs;
}

// ---------------------------------------------------------------- plan files exist

const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;
const TEST_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/i;

export interface IndexFileLookup {
  risk?: { files?: Record<string, unknown> } | null;
  byFile?: Map<string, unknown> | null;
}

/**
 * Non-test code files the plan edits that the codebase index does not know.
 * Test files may legitimately be created; non-code files (json, sql, md, yml)
 * are not reliably indexed and are never reported.
 */
export function planFilesMissingFromIndex(files: string[] | null | undefined, index: IndexFileLookup): string[] {
  const known = (p: string): boolean => {
    const clean = p.replace(/^\.\//, '');
    return !!(index.risk?.files && Object.prototype.hasOwnProperty.call(index.risk.files, clean))
      || !!(index.byFile && index.byFile.has(clean));
  };
  const out: string[] = [];
  for (const f of files || []) {
    if (typeof f !== 'string' || !CODE_EXT_RE.test(f) || TEST_RE.test(f)) continue;
    if (!known(f)) out.push(f);
  }
  return out;
}

/** DEV_AUTOPILOT_PLAN_FILE_CHECK=false disables; so does AGENT_CODE_INDEX_ENABLED=false (index off). */
export function isPlanFileCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.DEV_AUTOPILOT_PLAN_FILE_CHECK || '').trim().toLowerCase() === 'false') return false;
  return (env.AGENT_CODE_INDEX_ENABLED || '').trim().toLowerCase() !== 'false';
}
