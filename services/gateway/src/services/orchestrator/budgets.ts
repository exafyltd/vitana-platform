/**
 * VTID-04370 (Orchestrator v2, P2 — shadow): LLM spend budgets
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.2 "Budgets", §5 P2).
 *
 * Spend comes from the `llm.call.completed` OASIS events every router call
 * already writes (metadata: service, vtid, model, input/output tokens,
 * cost_estimate_usd). Budgets are evaluated per UTC day:
 *   - platform-wide     — sized to the owner's envelope ($6k/month now,
 *                         growing to at most $10k; plan §8.6 / VTID-04328);
 *   - per agent         — keyed by the telemetry `service`;
 *   - per run           — keyed by the telemetry `vtid`.
 * Exceeding one is a policy DENY (plan: "exceeding a budget is a policy
 * denial, not a crash"). Shadow: nothing calls this before a model call yet;
 * GET /api/v1/orchestrator/budgets shows what enforcement would do today.
 *
 * Per-tenant budgets need a tenant on the telemetry row, which it does not
 * carry today — named as a gap, not faked.
 *
 * Rows written before VTID-04370 priced every Bedrock call at $0 (MODEL_COSTS
 * had no inference-profile key). Those rows are repriced here from their
 * tokens, so today's numbers are real without rewriting history.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { estimateCost } from '../../constants/llm-defaults';

export const MONTHLY_ENVELOPE_USD = 6000;
export const MONTHLY_ENVELOPE_CAP_USD = 10000;

export interface BudgetLimits {
  platform_per_day_usd: number;
  agent_per_day_usd: Record<string, number>;
  agent_default_per_day_usd: number;
  run_per_day_usd: number;
}

/** Defaults. The platform line is the monthly envelope spread over 30 days. */
export const BUDGET_DEFAULTS: Readonly<BudgetLimits> = Object.freeze({
  platform_per_day_usd: Math.round((MONTHLY_ENVELOPE_USD / 30) * 100) / 100,
  agent_per_day_usd: Object.freeze({
    // Sized from 7 days of repriced telemetry (2026-09-16..22):
    //   autopilot-agent        peak $45/day  (coding agent, the heavy spender)
    //   db-i18n-translator     steady ~$33/day, every day (was reported $0)
    //   dev-autopilot-planning $3/day normal, $58 on 09-22 — the concurrent
    //                          re-planning defect (VTID-04228); 25 would deny it
    'autopilot-agent': 60,
    'db-i18n-translator': 40,
    'dev-autopilot-planning': 25,
  }) as Record<string, number>,
  agent_default_per_day_usd: 10,
  // The npm-audit retry chain (VTID-04237) cost ≈$3 per attempt; one run
  // above $8 in a day is a loop, not work.
  run_per_day_usd: 8,
});

export interface SpendRow {
  service: string | null;
  vtid: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_estimate_usd: number;
}

/** The row's cost, repriced from tokens when an old row recorded $0. */
export function rowCostUsd(r: SpendRow): number {
  if (r.cost_estimate_usd > 0) return r.cost_estimate_usd;
  if ((r.input_tokens > 0 || r.output_tokens > 0) && r.model) {
    return estimateCost(r.model, r.input_tokens, r.output_tokens);
  }
  return 0;
}

export interface SpendTotals {
  platform_usd: number;
  by_agent: Record<string, number>;
  by_run: Record<string, number>;
  calls: number;
  repriced_calls: number;
  unpriced_calls: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function aggregateSpend(rows: SpendRow[]): SpendTotals {
  const t: SpendTotals = { platform_usd: 0, by_agent: {}, by_run: {}, calls: 0, repriced_calls: 0, unpriced_calls: 0 };
  for (const r of rows) {
    const usd = rowCostUsd(r);
    t.calls++;
    if (!(r.cost_estimate_usd > 0) && usd > 0) t.repriced_calls++;
    if (usd === 0 && (r.input_tokens > 0 || r.output_tokens > 0)) t.unpriced_calls++;
    t.platform_usd += usd;
    const agent = r.service || 'unknown';
    t.by_agent[agent] = (t.by_agent[agent] ?? 0) + usd;
    if (r.vtid) t.by_run[r.vtid] = (t.by_run[r.vtid] ?? 0) + usd;
  }
  t.platform_usd = round4(t.platform_usd);
  for (const k of Object.keys(t.by_agent)) t.by_agent[k] = round4(t.by_agent[k]);
  for (const k of Object.keys(t.by_run)) t.by_run[k] = round4(t.by_run[k]);
  return t;
}

export type BudgetScope = 'platform' | 'agent' | 'run';

export interface BudgetDecision {
  decision: 'allow' | 'deny';
  scope: BudgetScope | null;
  key: string | null;
  spent_usd: number;
  limit_usd: number | null;
  reason: string;
}

export function agentLimit(agent: string, limits: BudgetLimits = BUDGET_DEFAULTS): number {
  return limits.agent_per_day_usd[agent] ?? limits.agent_default_per_day_usd;
}

/**
 * Would a new call by `agent` for `vtid` be allowed, given today's spend and
 * the estimated cost of the call? Checks platform, then agent, then run; the
 * first budget the call would exceed is the reason.
 */
export function evaluateBudget(
  spend: Pick<SpendTotals, 'platform_usd' | 'by_agent' | 'by_run'>,
  call: { agent: string; vtid?: string | null; estimated_usd?: number },
  limits: BudgetLimits = BUDGET_DEFAULTS,
): BudgetDecision {
  const add = Math.max(0, call.estimated_usd ?? 0);
  const checks: Array<[BudgetScope, string, number, number]> = [
    ['platform', 'platform', spend.platform_usd, limits.platform_per_day_usd],
    ['agent', call.agent, spend.by_agent[call.agent] ?? 0, agentLimit(call.agent, limits)],
  ];
  if (call.vtid) checks.push(['run', call.vtid, spend.by_run[call.vtid] ?? 0, limits.run_per_day_usd]);
  for (const [scope, key, spent, limit] of checks) {
    if (spent + add > limit) {
      return {
        decision: 'deny', scope, key, spent_usd: round4(spent), limit_usd: limit,
        reason: `${scope} budget ${key} exhausted: $${round4(spent)} spent today of $${limit}`,
      };
    }
  }
  return { decision: 'allow', scope: null, key: null, spent_usd: round4(spend.platform_usd), limit_usd: null, reason: 'within budget' };
}

export interface BudgetLine {
  scope: BudgetScope;
  key: string;
  spent_usd: number;
  limit_usd: number;
  used_pct: number;
  over: boolean;
}

/** Every agent/run line with spend today, most used first. */
export function budgetLines(spend: SpendTotals, limits: BudgetLimits = BUDGET_DEFAULTS): BudgetLine[] {
  const line = (scope: BudgetScope, key: string, spent: number, limit: number): BudgetLine => ({
    scope, key, spent_usd: spent, limit_usd: limit,
    used_pct: limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0,
    over: spent > limit,
  });
  const out: BudgetLine[] = [line('platform', 'platform', spend.platform_usd, limits.platform_per_day_usd)];
  for (const [a, v] of Object.entries(spend.by_agent)) out.push(line('agent', a, v, agentLimit(a, limits)));
  for (const [r, v] of Object.entries(spend.by_run)) out.push(line('run', r, v, limits.run_per_day_usd));
  return out.sort((x, y) => y.used_pct - x.used_pct);
}

export const SPEND_PAGE = 1000;
export const SPEND_MAX_ROWS = 20000;

/** Today's (UTC) spend rows from llm.call.completed. Read only. */
export async function loadSpendToday(
  sb: SupabaseClient,
  now: Date = new Date(),
): Promise<{ rows: SpendRow[]; since: string; truncated: boolean; error: string | null }> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const rows: SpendRow[] = [];
  for (let from = 0; from < SPEND_MAX_ROWS; from += SPEND_PAGE) {
    const { data, error } = await sb
      .from('oasis_events')
      .select('metadata')
      .eq('topic', 'llm.call.completed')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + SPEND_PAGE - 1);
    if (error) return { rows, since, truncated: false, error: error.message };
    const page = (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>;
    for (const e of page) {
      const m = e.metadata ?? {};
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      rows.push({
        service: typeof m.service === 'string' ? m.service : null,
        vtid: typeof m.vtid === 'string' ? m.vtid : null,
        model: typeof m.model === 'string' ? m.model : null,
        input_tokens: num(m.input_tokens),
        output_tokens: num(m.output_tokens),
        cost_estimate_usd: num(m.cost_estimate_usd),
      });
    }
    if (page.length < SPEND_PAGE) return { rows, since, truncated: false, error: null };
  }
  return { rows, since, truncated: true, error: null };
}
