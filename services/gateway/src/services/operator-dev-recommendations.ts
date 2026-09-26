/**
 * VTID-04582: what the Operator Console's autopilot_get_recommendations returns.
 *
 * The tool used to call the get_autopilot_recommendations RPC with
 * p_user_id = null. That RPC is the COMMUNITY recommender: with no user it
 * returns every member's nudges ("Complete your profile", "Add your photo",
 * "Start a streak on your weakest pillar"), and it never returns source_type.
 * Observed in the operator console 2026-09-25: an operator asked for the Dev
 * Autopilot recommendations and was shown ten community member nudges.
 *
 * The developer backlog is the Dev Autopilot supervisor snapshot (VTID-04281)
 * — the same payload the Command Hub Autopilot screens render: open
 * dev_autopilot / dev_autopilot_impact findings, each with the gate that is
 * holding it, plus in-flight executions and alerts. This module turns that
 * snapshot into the tool result. It is pure; the caller fetches the snapshot.
 */
import type { Recommendation } from './sync-brief-formatter';

export interface SnapshotFinding {
  id: string;
  title: string;
  status: string;
  source_type: string;
  detector: string | null;
  file_path: string | null;
  risk_class: string | null;
  effort_score: number | null;
  impact_score: number | null;
  has_plan: boolean;
  age_days: number;
  attempts: number;
  activated_vtid?: string | null;
  blocker: { code: string; actor: string; label: string; detail: string };
}

export interface DevRecommendationSnapshot {
  generated_at: string;
  config: Record<string, unknown>;
  executions: {
    active: number;
    active_by_status: Record<string, number>;
    awaiting_approval: number;
    total_7d: number;
    succeeded_7d: number;
    failed_7d: number;
    success_rate_7d: number | null;
    top_failure_reasons: Array<{ reason: string; count: number; last_seen_at?: string; count_24h?: number }>;
  };
  findings: { open: number; by_actor: Record<string, number>; items: SnapshotFinding[] };
  alerts: Array<{ severity?: string; text?: string; tab?: string } | string>;
}

/** Things a person can unblock come first; within a group, the snapshot's own order (impact desc). */
const ACTOR_ORDER: Record<string, number> = { human: 0, system: 1, waiting: 2, moving: 3 };

function priorityOf(riskClass: string | null): Recommendation['priority'] {
  if (riskClass === 'critical' || riskClass === 'high' || riskClass === 'low') return riskClass;
  return 'medium';
}

function alertText(a: DevRecommendationSnapshot['alerts'][number]): string {
  if (typeof a === 'string') return a;
  if (!a.text) return '';
  return a.severity ? `[${a.severity}] ${a.text}` : a.text;
}

export function toDevRecommendations(
  snap: DevRecommendationSnapshot,
  opts: { vtid?: string; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 25));
  const ordered = snap.findings.items
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (ACTOR_ORDER[a.f.blocker.actor] ?? 9) - (ACTOR_ORDER[b.f.blocker.actor] ?? 9) || a.i - b.i)
    .map(({ f }) => f);

  let scoped = ordered;
  let vtidMatched: boolean | null = null;
  if (opts.vtid) {
    const hits = ordered.filter((f) => f.activated_vtid === opts.vtid);
    vtidMatched = hits.length > 0;
    if (hits.length > 0) scoped = hits;
  }
  const top = scoped.slice(0, limit);

  const findings = top.map((f) => ({
    id: f.id,
    title: f.title,
    source: f.source_type === 'dev_autopilot_impact' ? 'impact_rule' : 'scanner',
    detector: f.detector,
    file_path: f.file_path,
    risk_class: f.risk_class,
    impact_score: f.impact_score,
    effort_score: f.effort_score,
    status: f.status,
    vtid: f.activated_vtid ?? null,
    has_plan: f.has_plan,
    attempts: f.attempts,
    age_days: f.age_days,
    blocked_by: f.blocker.actor,
    blocker: `${f.blocker.label} — ${f.blocker.detail}`,
  }));

  const recommendations: Recommendation[] = top.map((f) => ({
    id: f.id,
    title: f.title,
    priority: priorityOf(f.risk_class),
    rationale: [
      `Blocker (${f.blocker.actor}): ${f.blocker.label} — ${f.blocker.detail}`,
      f.detector ? `Detector: ${f.detector}` : '',
      f.file_path ? `File: ${f.file_path}` : '',
    ].filter(Boolean).join('. '),
    related_vtids: f.activated_vtid ? [f.activated_vtid] : [],
    requires_approval: f.blocker.actor === 'human',
    source: f.source_type,
  }));

  const e = snap.executions;
  return {
    source: 'dev_autopilot_supervisor' as const,
    generated_at: snap.generated_at,
    open_findings: snap.findings.open,
    findings_by_blocker: snap.findings.by_actor,
    shown: findings.length,
    vtid_filter: opts.vtid ? { vtid: opts.vtid, matched: vtidMatched } : null,
    findings,
    executions: {
      active: e.active,
      active_by_status: e.active_by_status,
      awaiting_approval: e.awaiting_approval,
      last_7d: { total: e.total_7d, succeeded: e.succeeded_7d, failed: e.failed_7d, success_rate: e.success_rate_7d },
      top_failure_reasons: e.top_failure_reasons.slice(0, 5),
    },
    config: snap.config,
    alerts: snap.alerts.map(alertText).filter(Boolean),
    recommendations,
  };
}
