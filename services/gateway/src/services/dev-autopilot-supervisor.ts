/**
 * VTID-04281: Dev Autopilot supervisor snapshot.
 *
 * The Autopilot tabs each showed one table (scanner registry, impact rules,
 * the auto-approve allowlist) with no way to tell whether the self-healing
 * loop was actually moving. Measured on staging 2026-09-22: 9 open findings
 * had sat at status='new' since 2026-09-21, 40 days of scans had failed
 * silently against a dead URL, ~75% of the week's executions had failed on
 * the agent turn cap, and the community automation engine had not run once
 * since 2026-08-15 — none of it visible on any Autopilot screen.
 *
 * This module answers the supervisor's questions in one payload:
 *   - Is the loop being fed?     scan cadence (last scan, overdue, failures)
 *   - Is work moving?            7-day funnel, success rate, active executions
 *   - What is stuck, and why?    a blocker diagnosis for every open finding,
 *                                attributed to "needs a human" vs "system"
 *   - Why do runs fail?          normalized failure reasons
 *   - Are PR gates firing?       impact-rule hits (open / 30 d / last fired)
 *   - How autonomous is it?      config coverage AND effective autonomy
 *
 * Every diagnosis mirrors a real gate in dev-autopilot-execute.ts
 * (autoApproveTick / lazyPlanTick / the PR-flood guard); keep them in step.
 */
import { getSupabase, supa, planRetryDecision, findingVtid } from './dev-autopilot-execute';
import { chunkIds } from './dev-autopilot-pipeline-guards';

type Supa = NonNullable<ReturnType<typeof getSupabase>>;

export const IN_FLIGHT_STATUSES = ['cooling', 'running', 'awaiting_approval', 'ci', 'merging', 'deploying', 'verifying'];
const TERMINAL_FAIL = ['failed', 'reverted', 'failed_escalated'];
const SCAN_CRON_HOURS_UTC = [7, 19];
/** GitHub delays scheduled runs by hours; 16 h without a scan is a miss. */
export const SCAN_OVERDUE_HOURS = 16;
const AUTO_RETRY_CAP = 5;

export interface SupervisorConfig {
  kill_switch: boolean;
  auto_approve_enabled: boolean;
  auto_approve_impact_enabled: boolean;
  auto_approve_risk_classes: string[];
  auto_approve_max_effort: number;
  auto_approve_scanners: string[];
  auto_approve_impact_rules: string[];
  daily_budget: number;
  concurrency_cap: number;
}

export interface OpenFinding {
  id: string;
  title: string;
  status: string;
  source_type: string;
  risk_class: string | null;
  effort_score: number | null;
  impact_score: number | null;
  snoozed_until: string | null;
  created_at: string;
  spec_snapshot: { scanner?: string; rule?: string; file_path?: string; severity?: string } | null;
}

export interface FindingExec {
  finding_id: string;
  status: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_closed: string | null;
  error: string | null;
  updated_at: string;
}

export type BlockerActor = 'moving' | 'system' | 'human' | 'waiting';

export interface FindingDiagnosis {
  code: string;
  actor: BlockerActor;
  label: string;
  detail: string;
}

export interface DiagnoseContext {
  cfg: SupervisorConfig;
  hasPlan: boolean;
  execs: FindingExec[];
  planFailures: { count: number; lastMs: number | null };
  nowMs: number;
  budgetLeft: number;
  concurrencyLeft: number;
}

/** Why an open finding is not moving. Order mirrors autoApproveTick. */
export function diagnoseFinding(f: OpenFinding, ctx: DiagnoseContext): FindingDiagnosis {
  const { cfg } = ctx;
  const inflight = ctx.execs.find((e) => IN_FLIGHT_STATUSES.includes(e.status));
  if (inflight) {
    return {
      code: 'in_flight',
      actor: inflight.status === 'awaiting_approval' ? 'human' : 'moving',
      label: inflight.status === 'awaiting_approval' ? 'Awaiting your approval' : `Executing (${inflight.status})`,
      detail: inflight.status === 'awaiting_approval'
        ? 'Branch pushed; the PR opens when a human approves it on the Live tab.'
        : 'An execution for this finding is in progress.',
    };
  }
  if (f.status === 'snoozed' && f.snoozed_until && Date.parse(f.snoozed_until) > ctx.nowMs) {
    const lastErr = ctx.execs.find((e) => e.error)?.error || null;
    return {
      code: 'snoozed',
      actor: 'waiting',
      label: `Snoozed until ${f.snoozed_until.slice(0, 10)}`,
      detail: lastErr ? `Last failure: ${lastErr.slice(0, 160)}` : 'Snoozed by an operator or a retry breaker.',
    };
  }
  if (cfg.kill_switch) {
    return { code: 'kill_switch', actor: 'human', label: 'Kill switch ON', detail: 'All autonomous execution is paused.' };
  }
  const isImpact = f.source_type === 'dev_autopilot_impact';
  if (isImpact) {
    if (!cfg.auto_approve_impact_enabled) {
      return { code: 'impact_auto_off', actor: 'human', label: 'Needs approval (impact auto-approve OFF)', detail: 'Impact auto-approve is switched off.' };
    }
    const rule = f.spec_snapshot?.rule || '';
    if (!cfg.auto_approve_impact_rules.includes(rule)) {
      return { code: 'rule_not_opted_in', actor: 'human', label: 'Needs approval (rule not opted in)', detail: `Rule ${rule || '?'} is not in auto_approve_impact_rules.` };
    }
  } else {
    if (!cfg.auto_approve_enabled) {
      return { code: 'baseline_auto_off', actor: 'human', label: 'Needs approval (auto-approve OFF)', detail: 'Baseline auto-approve is switched off.' };
    }
    const risk = f.risk_class || 'unknown';
    if (!cfg.auto_approve_risk_classes.includes(risk)) {
      return { code: 'risk_too_high', actor: 'human', label: `Needs approval (risk ${risk})`, detail: `Auto-approve only takes risk ${cfg.auto_approve_risk_classes.join('/')}.` };
    }
    if ((f.effort_score ?? 0) > cfg.auto_approve_max_effort) {
      return { code: 'effort_too_high', actor: 'human', label: `Needs approval (effort ${f.effort_score})`, detail: `Auto-approve max effort is ${cfg.auto_approve_max_effort}.` };
    }
    const scanner = f.spec_snapshot?.scanner || '';
    if (!cfg.auto_approve_scanners.includes(scanner)) {
      return { code: 'scanner_not_opted_in', actor: 'human', label: 'Needs approval (scanner not opted in)', detail: `Scanner ${scanner || '?'} is not in auto_approve_scanners.` };
    }
  }
  const stranded = ctx.execs.find((e) => e.pr_url && !e.pr_closed && !['completed', 'self_healed', 'auto_archived'].includes(e.status));
  if (stranded) {
    return {
      code: 'stranded_pr',
      actor: 'system',
      label: `Blocked by PR #${stranded.pr_number ?? '?'}`,
      detail: `A prior execution (${stranded.status}) left PR #${stranded.pr_number ?? '?'} not recorded as closed. The closed-PR reconciler clears this within minutes once GitHub reports it closed.`,
    };
  }
  if (!ctx.hasPlan) {
    if (!isImpact && !['low', 'medium'].includes(f.risk_class || '')) {
      return { code: 'no_plan_high_risk', actor: 'human', label: 'No plan (high risk — not auto-planned)', detail: 'The lazy planner only plans low/medium findings.' };
    }
    const d = planRetryDecision(ctx.planFailures.count, ctx.planFailures.lastMs, ctx.nowMs);
    if (!d.attempt && d.reason === 'exhausted') {
      return { code: 'plan_failed', actor: 'system', label: `Planning failed ${ctx.planFailures.count}×`, detail: 'Plan generation keeps failing; the planner has stopped retrying.' };
    }
    if (!d.attempt) {
      return { code: 'plan_backoff', actor: 'system', label: 'Planning retry backoff', detail: `Plan generation failed ${ctx.planFailures.count}× — retrying with backoff.` };
    }
    return { code: 'awaiting_plan', actor: 'moving', label: 'Queued for planning', detail: 'The lazy planner plans up to 3 findings every 30 s.' };
  }
  const dayAgo = ctx.nowMs - 24 * 3600 * 1000;
  const recentFailures = ctx.execs.filter((e) => TERMINAL_FAIL.includes(e.status) && Date.parse(e.updated_at) >= dayAgo);
  if (recentFailures.length >= AUTO_RETRY_CAP) {
    return { code: 'retry_cap', actor: 'system', label: `Retry cap (${recentFailures.length} failures / 24h)`, detail: 'Will be snoozed 7 days on the next tick.' };
  }
  if (ctx.budgetLeft <= 0) return { code: 'budget_exhausted', actor: 'waiting', label: 'Daily budget used up', detail: 'Resumes after 00:00 UTC.' };
  if (ctx.concurrencyLeft <= 0) return { code: 'concurrency_full', actor: 'waiting', label: 'Waiting for a free slot', detail: 'Concurrency cap reached.' };
  return { code: 'ready', actor: 'moving', label: 'Ready — next auto-approve tick', detail: 'All gates pass; picked up within ~30 s.' };
}

export interface ScanRun {
  run_id: string;
  triggered_by: string | null;
  status: string;
  signal_count: number | null;
  new_finding_count: number | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export function nextScheduledScan(nowMs: number): string {
  const d = new Date(nowMs);
  for (let add = 0; add < 2; add++) {
    for (const h of SCAN_CRON_HOURS_UTC) {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, h, 0, 0);
      if (t > nowMs) return new Date(t).toISOString();
    }
  }
  return new Date(nowMs + 12 * 3600 * 1000).toISOString();
}

export function summarizeScanCadence(runs: ScanRun[], nowMs: number) {
  const sorted = [...runs].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const last = sorted[0] || null;
  const lastDone = sorted.find((r) => r.status === 'done') || null;
  const weekAgo = nowMs - 7 * 24 * 3600 * 1000;
  const week = sorted.filter((r) => Date.parse(r.started_at) >= weekAgo);
  const stuck = sorted.filter((r) => r.status !== 'done' && r.status !== 'failed' && !r.completed_at
    && nowMs - Date.parse(r.started_at) > 30 * 60 * 1000);
  const hoursSinceDone = lastDone ? (nowMs - Date.parse(lastDone.started_at)) / 3600000 : null;
  return {
    schedule: 'GitHub Actions cron 07:00 + 19:00 UTC (often delayed by hours)',
    last_run: last,
    last_success_at: lastDone ? lastDone.started_at : null,
    hours_since_success: hoursSinceDone === null ? null : Math.round(hoursSinceDone * 10) / 10,
    overdue: hoursSinceDone === null || hoursSinceDone > SCAN_OVERDUE_HOURS,
    next_scheduled_at: nextScheduledScan(nowMs),
    runs_7d: week.length,
    failed_7d: week.filter((r) => r.status === 'failed').length,
    new_findings_7d: week.reduce((a, r) => a + (r.new_finding_count || 0), 0),
    stuck_runs: stuck.map((r) => ({ run_id: r.run_id, status: r.status, started_at: r.started_at })),
  };
}

export interface ExecRow {
  id: string;
  finding_id: string;
  status: string;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  pr_number: number | null;
  error: string | null;
  /** Source of the finding this execution fixes (operator_onramp = a human asked for it in the Operator Console). */
  source_type?: string | null;
}

/** Where the work came from — only non-operator rows count as self-healing. */
export function executionOrigin(sourceType: string | null | undefined): 'operator' | 'scanner' | 'impact' | 'other' {
  if (sourceType === 'operator_onramp') return 'operator';
  if (sourceType === 'dev_autopilot') return 'scanner';
  if (sourceType === 'dev_autopilot_impact') return 'impact';
  return 'other';
}

/** Collapse ids/numbers so one failure class groups as one row. */
export function normalizeFailureReason(err: string | null | undefined): string {
  if (!err) return '(no error recorded)';
  return err
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8}\b/gi, '<id>')
    .replace(/#\d+/g, '#<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function summarizeExecutions(execs: ExecRow[], nowMs: number) {
  const weekAgo = nowMs - 7 * 24 * 3600 * 1000;
  const dayAgo = nowMs - 24 * 3600 * 1000;
  const week = execs.filter((e) => Date.parse(e.created_at) >= weekAgo);
  const byStatus: Record<string, number> = {};
  for (const e of week) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  const success = week.filter((e) => e.status === 'completed' || e.status === 'self_healed').length;
  const failed = week.filter((e) => TERMINAL_FAIL.includes(e.status)).length;
  const decided = success + failed;
  // Auto = no human approver AND not requested by a human in the Operator Console.
  const auto = week.filter((e) => !e.approved_by && executionOrigin(e.source_type) !== 'operator').length;
  const byOrigin: Record<string, { total: number; succeeded: number; failed: number }> = {};
  for (const e of week) {
    const o = executionOrigin(e.source_type);
    const b = byOrigin[o] || (byOrigin[o] = { total: 0, succeeded: 0, failed: 0 });
    b.total++;
    if (e.status === 'completed' || e.status === 'self_healed') b.succeeded++;
    if (TERMINAL_FAIL.includes(e.status)) b.failed++;
  }
  const reasons = new Map<string, number>();
  for (const e of week) {
    if (!TERMINAL_FAIL.includes(e.status)) continue;
    const k = normalizeFailureReason(e.error);
    reasons.set(k, (reasons.get(k) || 0) + 1);
  }
  const active = execs.filter((e) => IN_FLIGHT_STATUSES.includes(e.status));
  const activeByStatus: Record<string, number> = {};
  for (const e of active) activeByStatus[e.status] = (activeByStatus[e.status] || 0) + 1;
  return {
    window_days: 7,
    total_7d: week.length,
    last_24h: execs.filter((e) => Date.parse(e.created_at) >= dayAgo).length,
    by_status_7d: byStatus,
    succeeded_7d: success,
    failed_7d: failed,
    success_rate_7d: decided > 0 ? Math.round((success / decided) * 100) : null,
    auto_approved_7d: auto,
    human_approved_7d: week.length - auto,
    by_origin_7d: byOrigin,
    prs_opened_7d: week.filter((e) => e.pr_number != null).length,
    active: active.length,
    active_by_status: activeByStatus,
    awaiting_approval: activeByStatus['awaiting_approval'] || 0,
    last_execution_at: execs.reduce<string | null>((m, e) => (!m || e.created_at > m ? e.created_at : m), null),
    top_failure_reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
  };
}

export function summarizeRuleHits(
  rules: Array<{ rule: string; severity: string; title: string }>,
  recs: Array<{ rule: string | null; status: string; created_at: string }>,
) {
  return rules.map((r) => {
    const mine = recs.filter((x) => x.rule === r.rule);
    return {
      rule: r.rule,
      title: r.title,
      severity: r.severity,
      open: mine.filter((x) => x.status === 'new').length,
      hits_30d: mine.length,
      rejected_30d: mine.filter((x) => x.status === 'rejected').length,
      last_fired_at: mine.reduce<string | null>((m, x) => (!m || x.created_at > m ? x.created_at : m), null),
    };
  });
}

export interface SupervisorAlert { severity: 'critical' | 'warning' | 'info'; text: string; tab: string }

export function buildAlerts(input: {
  cfg: SupervisorConfig;
  scan: ReturnType<typeof summarizeScanCadence>;
  exec: ReturnType<typeof summarizeExecutions>;
  blockers: Record<string, number>;
  communityEngineLastRunAt: string | null;
  nowMs: number;
}): SupervisorAlert[] {
  const a: SupervisorAlert[] = [];
  if (input.cfg.kill_switch) a.push({ severity: 'critical', text: 'Kill switch is ON — no autonomous execution.', tab: 'auto-approve' });
  if (input.scan.overdue) {
    a.push({ severity: 'critical', text: input.scan.hours_since_success === null
      ? 'No successful scan on record.'
      : `No successful scan for ${input.scan.hours_since_success} h (expected every ~12 h).`, tab: 'runs' });
  }
  if (input.scan.failed_7d > 0) a.push({ severity: 'warning', text: `${input.scan.failed_7d} scan run(s) failed in 7 days.`, tab: 'runs' });
  if (input.scan.stuck_runs.length > 0) a.push({ severity: 'warning', text: `${input.scan.stuck_runs.length} scan run(s) never finalized.`, tab: 'runs' });
  if (input.exec.success_rate_7d !== null && input.exec.success_rate_7d < 50 && input.exec.failed_7d >= 5) {
    const top = input.exec.top_failure_reasons[0];
    a.push({ severity: 'critical', text: `Only ${input.exec.success_rate_7d}% of finished executions succeeded in 7 days${top ? ` — top cause: "${top.reason}" (${top.count}×)` : ''}.`, tab: 'live' });
  }
  const o = input.exec.by_origin_7d || {};
  const selfTotal = (o.scanner?.total || 0) + (o.impact?.total || 0);
  const selfOk = (o.scanner?.succeeded || 0) + (o.impact?.succeeded || 0);
  if (selfTotal >= 3 && selfOk / selfTotal < 0.3) {
    a.push({ severity: 'critical', text: `Self-healing: ${selfOk} of ${selfTotal} executions started from scanner/impact findings succeeded in 7 days.`, tab: 'live' });
  }
  if (input.exec.awaiting_approval > 0) a.push({ severity: 'warning', text: `${input.exec.awaiting_approval} execution(s) waiting for your approval.`, tab: 'live' });
  const human = input.blockers.human || 0;
  const system = input.blockers.system || 0;
  if (system > 0) a.push({ severity: 'warning', text: `${system} open finding(s) stuck on a system blocker.`, tab: 'scanners' });
  if (human > 0) a.push({ severity: 'info', text: `${human} open finding(s) need a human decision (not eligible for auto-approve).`, tab: 'auto-approve' });
  if (input.communityEngineLastRunAt) {
    const days = Math.floor((input.nowMs - Date.parse(input.communityEngineLastRunAt)) / 86400000);
    if (days >= 2) a.push({ severity: 'critical', text: `Community automation engine (AP-XXXX) has not run for ${days} days — its Cloud Scheduler triggers died with GCP.`, tab: 'registry' });
  } else {
    a.push({ severity: 'warning', text: 'Community automation engine (AP-XXXX) has no recorded runs.', tab: 'registry' });
  }
  return a;
}

async function get<T>(s: Supa, path: string): Promise<T | null> {
  const r = await supa<T>(s, path);
  return r.ok && r.data !== undefined ? r.data : null;
}

export async function buildSupervisorSnapshot(nowMs: number = Date.now()) {
  const s = getSupabase();
  if (!s) return { ok: false as const, error: 'Supabase not configured' };

  const cfgRows = await get<SupervisorConfig[]>(s,
    '/rest/v1/dev_autopilot_config?id=eq.1&select=kill_switch,auto_approve_enabled,auto_approve_impact_enabled,'
    + 'auto_approve_risk_classes,auto_approve_max_effort,auto_approve_scanners,auto_approve_impact_rules,daily_budget,concurrency_cap&limit=1');
  const cfgRow = cfgRows && cfgRows[0];
  if (!cfgRow) return { ok: false as const, error: 'dev_autopilot_config missing' };
  const cfg: SupervisorConfig = {
    ...cfgRow,
    auto_approve_risk_classes: cfgRow.auto_approve_risk_classes?.length ? cfgRow.auto_approve_risk_classes : ['low', 'medium'],
    auto_approve_scanners: cfgRow.auto_approve_scanners || [],
    auto_approve_impact_rules: cfgRow.auto_approve_impact_rules || [],
    auto_approve_max_effort: cfgRow.auto_approve_max_effort ?? 5,
  };

  const weekAgoIso = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString();
  const monthAgoIso = new Date(nowMs - 30 * 24 * 3600 * 1000).toISOString();
  const dayStart = new Date(nowMs); dayStart.setUTCHours(0, 0, 0, 0);

  const [findings, runs, execs, rules, impactRecs, scanners, engineLast, approvedToday] = await Promise.all([
    get<OpenFinding[]>(s, '/rest/v1/autopilot_recommendations?source_type=in.(dev_autopilot,dev_autopilot_impact)'
      + '&status=in.(new,snoozed)&select=id,title,status,source_type,risk_class,effort_score,impact_score,snoozed_until,created_at,spec_snapshot'
      + '&order=impact_score.desc.nullslast,created_at.asc&limit=300'),
    get<ScanRun[]>(s, '/rest/v1/dev_autopilot_runs?select=run_id,triggered_by,status,signal_count,new_finding_count,started_at,completed_at,error&order=started_at.desc&limit=40'),
    get<Array<ExecRow & { finding?: { source_type?: string | null } | null }>>(s, `/rest/v1/dev_autopilot_executions?or=(created_at.gte.${encodeURIComponent(weekAgoIso)},status.in.(${IN_FLIGHT_STATUSES.join(',')}))`
      + '&select=id,finding_id,status,approved_by,created_at,updated_at,pr_number,error:metadata->>error,finding:autopilot_recommendations(source_type)'
      + '&order=created_at.desc&limit=1000'),
    get<Array<{ rule: string; severity: string; title: string }>>(s, '/rest/v1/dev_autopilot_impact_rules?select=rule,severity,title&order=rule.asc'),
    get<Array<{ rule: string | null; status: string; created_at: string }>>(s,
      `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot_impact&created_at=gte.${encodeURIComponent(monthAgoIso)}`
      + '&select=rule:spec_snapshot->>rule,status,created_at&limit=2000'),
    get<Array<{ scanner: string; title: string; enabled: boolean }>>(s, '/rest/v1/dev_autopilot_scanners?select=scanner,title,enabled'),
    get<Array<{ started_at: string }>>(s, '/rest/v1/automation_runs?select=started_at&order=started_at.desc&limit=1'),
    get<Array<{ id: string }>>(s, `/rest/v1/dev_autopilot_executions?approved_at=gte.${encodeURIComponent(dayStart.toISOString())}&select=id`),
  ]);

  const open = findings || [];
  const ids = open.map((f) => f.id);
  const planned = new Set<string>();
  const execsByFinding = new Map<string, FindingExec[]>();
  for (const chunk of chunkIds(ids)) {
    if (chunk.length === 0) continue;
    const list = chunk.join(',');
    const [p, e] = await Promise.all([
      get<Array<{ finding_id: string }>>(s, `/rest/v1/dev_autopilot_plan_versions?finding_id=in.(${list})&select=finding_id`),
      get<FindingExec[]>(s, `/rest/v1/dev_autopilot_executions?finding_id=in.(${list})`
        + '&select=finding_id,status,pr_number,pr_url,updated_at,pr_closed:metadata->>pr_closed_unmerged_at,error:metadata->>error'
        + '&order=updated_at.desc&limit=1000'),
    ]);
    for (const row of p || []) planned.add(row.finding_id);
    for (const row of e || []) {
      const arr = execsByFinding.get(row.finding_id) || [];
      arr.push(row);
      execsByFinding.set(row.finding_id, arr);
    }
  }
  const planFailRows = await get<Array<{ vtid: string; created_at: string }>>(s,
    `/rest/v1/self_healing_log?vtid=like.VTID-DA-FIND-*&failure_class=in.(dev_autopilot_plan_gen_failed,dev_autopilot_worker_binary_missing)`
    + `&created_at=gte.${encodeURIComponent(new Date(nowMs - 24 * 3600 * 1000).toISOString())}&select=vtid,created_at`);
  const planFail = new Map<string, { count: number; lastMs: number | null }>();
  for (const r of planFailRows || []) {
    const prev = planFail.get(r.vtid) || { count: 0, lastMs: null };
    const t = Date.parse(r.created_at);
    planFail.set(r.vtid, { count: prev.count + 1, lastMs: prev.lastMs === null ? t : Math.max(prev.lastMs, t) });
  }

  const execRows: ExecRow[] = (execs || []).map((e) => ({ ...e, source_type: e.source_type ?? e.finding?.source_type ?? null }));
  const execSummary = summarizeExecutions(execRows, nowMs);
  const budgetLeft = Math.max(0, cfg.daily_budget - (approvedToday || []).length);
  const running = execRows.filter((e) => ['running', 'ci', 'merging', 'deploying', 'verifying'].includes(e.status)).length;
  const concurrencyLeft = Math.max(0, cfg.concurrency_cap - running);

  const diagnosed = open.map((f) => {
    const d = diagnoseFinding(f, {
      cfg,
      hasPlan: planned.has(f.id),
      execs: execsByFinding.get(f.id) || [],
      planFailures: planFail.get(findingVtid(f.id)) || { count: 0, lastMs: null },
      nowMs,
      budgetLeft,
      concurrencyLeft,
    });
    return {
      id: f.id,
      title: f.title,
      status: f.status,
      source_type: f.source_type,
      detector: f.spec_snapshot?.scanner || f.spec_snapshot?.rule || null,
      file_path: f.spec_snapshot?.file_path || null,
      risk_class: f.risk_class,
      effort_score: f.effort_score,
      impact_score: f.impact_score,
      has_plan: planned.has(f.id),
      age_days: Math.floor((nowMs - Date.parse(f.created_at)) / 86400000),
      attempts: (execsByFinding.get(f.id) || []).length,
      blocker: d,
    };
  });
  const blockerCounts: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const f of diagnosed) {
    blockerCounts[f.blocker.actor] = (blockerCounts[f.blocker.actor] || 0) + 1;
    byCode[f.blocker.code] = (byCode[f.blocker.code] || 0) + 1;
  }

  const scan = summarizeScanCadence(runs || [], nowMs);
  const scannerList = scanners || [];
  const ruleList = rules || [];
  const coveredScanners = scannerList.filter((x) => cfg.auto_approve_enabled && cfg.auto_approve_scanners.includes(x.scanner)).length;
  const coveredRules = ruleList.filter((x) => cfg.auto_approve_impact_enabled && cfg.auto_approve_impact_rules.includes(x.rule)).length;
  const totalSurfaces = scannerList.length + ruleList.length;
  const eligibleOpen = diagnosed.filter((f) => f.blocker.actor !== 'human').length;
  const communityEngineLastRunAt = engineLast && engineLast[0] ? engineLast[0].started_at : null;

  return {
    ok: true as const,
    generated_at: new Date(nowMs).toISOString(),
    config: {
      kill_switch: cfg.kill_switch,
      baseline_auto_approve: cfg.auto_approve_enabled,
      impact_auto_approve: cfg.auto_approve_impact_enabled,
      daily_budget: cfg.daily_budget,
      budget_left_today: budgetLeft,
      concurrency_cap: cfg.concurrency_cap,
      concurrency_left: concurrencyLeft,
    },
    scan,
    executions: execSummary,
    findings: {
      open: diagnosed.length,
      by_actor: blockerCounts,
      by_code: byCode,
      items: diagnosed,
    },
    autonomy: {
      config_coverage_percent: totalSurfaces > 0 ? Math.round(((coveredScanners + coveredRules) / totalSurfaces) * 100) : 0,
      covered_surfaces: coveredScanners + coveredRules,
      total_surfaces: totalSurfaces,
      /** Share of open findings the system can resolve without a human. */
      open_findings_autonomous_percent: diagnosed.length > 0 ? Math.round((eligibleOpen / diagnosed.length) * 100) : null,
      /** Share of this week's executions started without a human. */
      executions_auto_approved_percent: execSummary.total_7d > 0 ? Math.round((execSummary.auto_approved_7d / execSummary.total_7d) * 100) : null,
    },
    impact_rules: summarizeRuleHits(ruleList, impactRecs || []),
    community_engine: {
      last_run_at: communityEngineLastRunAt,
      days_since_last_run: communityEngineLastRunAt ? Math.floor((nowMs - Date.parse(communityEngineLastRunAt)) / 86400000) : null,
    },
    alerts: buildAlerts({ cfg, scan, exec: execSummary, blockers: blockerCounts, communityEngineLastRunAt, nowMs }),
  };
}
