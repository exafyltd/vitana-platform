/**
 * VTID-04825: Jev P3 F (second slice) — the learning loop's root-cause
 * classes and their weekly roll-up. (docs/JEV-INTEGRATION-PLAN.md §10.4 F)
 *
 *   root_cause_rollup   (JEV_ROOT_CAUSE_ROLLUP_MODE = off | shadow | enforce)
 *
 * A Dev Autopilot execution that ends badly (failed, reverted, escalated,
 * cancelled) leaves its reason scattered over free-text fields: an error
 * string, a gate reason, failed check names, a failure stage. Nobody counts
 * them, so the same cause (a daily Bedrock token quota, a scope guard
 * tripping on a generated file) repeats for weeks before anyone notices.
 *
 * Once per UTC day, every execution that ended badly the day before gets a
 * root-cause class from Jev `execution_root_cause` (error text redacted and
 * cut, never plan bodies or diffs), next to a keyword rule on the same text;
 * agreement where the rule names a class. Every Monday, the classes of the
 * last seven days — these rows and B3's incident causes
 * (`selfheal_pretriage`) — are counted, and each class seen at least
 * MIN_WEEKLY times is recorded as `would_open_finding`. Opening those
 * findings is enforce, after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';
import { PRETRIAGE_GATE } from './selfheal-gates';
import { TURN_CAP_FAILURE_RE } from '../../dev-autopilot-retry-breaker';

export const ROOT_CAUSE_GATE = 'root_cause_rollup';
export const ENDED_STATUSES = ['failed', 'failed_escalated', 'reverted', 'cancelled'] as const;
export const MIN_WEEKLY = 3;
const MAX_PER_DAY = 40;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-learning', system: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

export const ROOT_CAUSES = [
  'llm_quota_or_outage', 'scope_violation', 'ci_test_failure', 'merge_conflict', 'deploy_failure',
  'verification_regression', 'plan_too_broad', 'agent_turn_cap', 'cancelled_by_human', 'unknown',
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export interface EndedExecution {
  id: string;
  status: string;
  failure_stage: string | null;
  metadata: Record<string, any> | null;
}

/** What Jev sees about an ended execution: status, stage and the failure texts, cut. Pure. */
export function rootCauseInput(e: EndedExecution) {
  const m = e.metadata || {};
  const checks = Array.isArray(m.failed_checks) ? m.failed_checks.map((c: any) => String(c?.name ?? c).slice(0, 80)).slice(0, 10) : [];
  return {
    status: e.status.slice(0, 30),
    failure_stage: str(e.failure_stage, 30),
    error: str(m.error, 400),
    gate_reason: str(m.gate_reason, 200),
    bridge_reason: str(m.bridge_reason_decision, 200),
    deploy_error: str(m.deploy_error, 200),
    failed_checks: checks,
    fix_mode: m.fix_mode === true || m.bridge_fix_mode === true,
    cancelled_by_human: m.cancelled === true || m.rejected === true,
  };
}

/** The keyword rule: a class when the texts say so, else null (open). Pure. */
export function ruleRootCause(i: ReturnType<typeof rootCauseInput>): RootCause | null {
  const text = [i.error, i.gate_reason, i.bridge_reason, i.deploy_error].filter(Boolean).join(' ');
  if (i.status === 'cancelled' || i.cancelled_by_human) return 'cancelled_by_human';
  if (/too many tokens|both providers failed|throttl|rate limit|provider outage|overloaded/i.test(text)) return 'llm_quota_or_outage';
  if (/scope violation|outside_allow_scope|outside allow scope/i.test(text)) return 'scope_violation';
  if (TURN_CAP_FAILURE_RE.test(text)) return 'agent_turn_cap';
  if (/mergeable_state=dirty|merge conflict/i.test(text)) return 'merge_conflict';
  if (i.failure_stage === 'deploy' || i.deploy_error) return 'deploy_failure';
  if (i.failure_stage === 'verification') return 'verification_regression';
  if (i.failure_stage === 'ci' && i.failed_checks.length > 0) return 'ci_test_failure';
  return null;
}

export function isRootCauseRollupOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(ROOT_CAUSE_GATE, env) !== 'off';
}

export interface RollupDeps {
  sb: SupabaseClient;
  env?: NodeJS.ProcessEnv;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
  now?: () => number;
}

/** Classify the executions that ended badly on one UTC day (YYYY-MM-DD). Returns rows written; never throws. */
export async function classifyEndedExecutions(day: string, d: RollupDeps): Promise<number> {
  const env = d.env ?? process.env;
  const mode = jevGateMode(ROOT_CAUSE_GATE, env);
  if (mode === 'off') return 0;
  let written = 0;
  try {
    const since = `${day}T00:00:00.000Z`;
    const until = new Date(Date.parse(since) + DAY_MS).toISOString();
    const { data, error } = await repo.fetchEndedExecutions(d.sb, ENDED_STATUSES, since, until, MAX_PER_DAY);
    if (error || !data) return 0;
    for (const e of data as EndedExecution[]) {
      const seen = await repo.fetchRecentShadowBySubject(d.sb, ROOT_CAUSE_GATE, e.id, new Date(Date.parse(since) - 30 * DAY_MS).toISOString());
      if (!seen.error && seen.data) continue;
      const input = rootCauseInput(e);
      const rule = ruleRootCause(input);
      const r = await decide('execution_root_cause', input, SYSTEM_CALLER, { ...(d.decideOptions || {}), source: `gate:${ROOT_CAUSE_GATE}`, env });
      const cause = r.ok && r.outcome === 'decided' ? (String(r.verdict.value) as RootCause) : null;
      const agreed = cause === null || rule === null ? null : cause === rule;
      const id = await recordJevShadowDecision(
        {
          gate: ROOT_CAUSE_GATE,
          decision: 'execution_root_cause',
          mode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'dev_autopilot_execution',
          subject_ref: e.id,
          jev_outcome: r.outcome,
          jev_verdict: r.ok
            ? { cause, probability: r.answers.cause?.probability ?? null, rule_cause: rule, status: input.status, stage: input.failure_stage ?? null, day }
            : { reason: r.reason, rule_cause: rule, status: input.status, stage: input.failure_stage ?? null, day },
          jev_confidence: r.ok ? r.verdict.confidence : null,
          system_action: rule ? `rule_${rule}` : 'rule_none',
          cost_usd: r.ok ? r.cost_usd : 0,
          agreed,
          outcome: agreed === null ? null : 'compared_with_text_rule',
          outcome_at: agreed === null ? null : new Date((d.now ?? Date.now)()).toISOString(),
        },
        d.sb,
      );
      if (id) written++;
    }
  } catch (err: any) {
    console.warn(`[jev] ${ROOT_CAUSE_GATE} classify ${day} failed: ${err?.message || err}`);
  }
  return written;
}

/** The class a row counts as: Jev's when decided, else the rule's. Pure. */
export function classOfRow(row: { decision?: string; jev_verdict?: any }): { source: 'execution' | 'incident'; cls: string } | null {
  const v = row.jev_verdict || {};
  if (row.decision === 'execution_root_cause') {
    const cls = v.cause ?? v.rule_cause;
    return cls ? { source: 'execution', cls: String(cls) } : null;
  }
  const cls = v.cause ?? v.class;
  return cls && cls !== 'unknown' ? { source: 'incident', cls: String(cls) } : null;
}

/** Count the week's classes. Pure. */
export function countClasses(rows: Array<{ id: string; decision?: string; jev_verdict?: any }>): Array<{ source: string; cls: string; count: number; examples: string[] }> {
  const m = new Map<string, { source: string; cls: string; count: number; examples: string[] }>();
  for (const row of rows) {
    const c = classOfRow(row);
    if (!c) continue;
    const k = `${c.source}:${c.cls}`;
    const e = m.get(k) ?? { source: c.source, cls: c.cls, count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 5) e.examples.push(row.id);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** The Monday roll-up for the seven days ending at `untilDay` (exclusive, YYYY-MM-DD). Rules only, no Jev call. Never throws. */
export async function weeklyRollup(untilDay: string, d: RollupDeps): Promise<number> {
  const env = d.env ?? process.env;
  const mode = jevGateMode(ROOT_CAUSE_GATE, env);
  if (mode === 'off') return 0;
  let written = 0;
  try {
    const until = `${untilDay}T00:00:00.000Z`;
    const since = new Date(Date.parse(until) - 7 * DAY_MS).toISOString();
    const [own, incidents] = await Promise.all([
      repo.fetchShadowRowsByGate(d.sb, ROOT_CAUSE_GATE, since, until),
      repo.fetchShadowRowsByGate(d.sb, PRETRIAGE_GATE, since, until),
    ]);
    const rows = [...((own.data as any[]) || []).filter((r) => r.decision === 'execution_root_cause'), ...((incidents.data as any[]) || [])];
    for (const c of countClasses(rows).filter((x) => x.count >= MIN_WEEKLY)) {
      const key = `${untilDay}:${c.source}:${c.cls}`.slice(0, 200);
      const seen = await repo.fetchRecentShadowBySubject(d.sb, ROOT_CAUSE_GATE, key, since);
      if (!seen.error && seen.data) continue;
      const id = await recordJevShadowDecision(
        {
          gate: ROOT_CAUSE_GATE,
          decision: 'rules:weekly_rollup',
          mode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'root_cause_class',
          subject_ref: key,
          jev_outcome: 'decided',
          jev_verdict: { source: 'rules', class: c.cls, origin: c.source, count: c.count, examples: c.examples, week_ending: untilDay, min_weekly: MIN_WEEKLY },
          jev_confidence: 1,
          system_action: 'would_open_finding',
          cost_usd: 0,
        },
        d.sb,
      );
      if (id) written++;
    }
  } catch (err: any) {
    console.warn(`[jev] ${ROOT_CAUSE_GATE} weekly roll-up ${untilDay} failed: ${err?.message || err}`);
  }
  return written;
}

let timerId: ReturnType<typeof setInterval> | null = null;
let lastDay: string | null = null;

/** Hourly tick: yesterday's ended executions once per day; the roll-up on Mondays (UTC). */
export function startRootCauseScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (timerId || !isRootCauseRollupOn(env)) return false;
  const tick = async () => {
    const sb = getSupabase();
    if (!sb) return;
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (lastDay === today) return;
    await classifyEndedExecutions(new Date(now - DAY_MS).toISOString().slice(0, 10), { sb, env });
    if (new Date(now).getUTCDay() === 1) await weeklyRollup(today, { sb, env });
    lastDay = today;
  };
  timerId = setInterval(() => { void tick(); }, TICK_MS);
  timerId.unref?.();
  void tick();
  return true;
}

export function stopRootCauseSchedulerForTest(): void {
  if (timerId) clearInterval(timerId);
  timerId = null;
  lastDay = null;
}
