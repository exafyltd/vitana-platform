/**
 * VTID-04473: Jev decision telemetry.
 *
 * One OASIS event per decision call (jev.decision.completed / .failed /
 * .fallback) carrying who, which decision, which plane, tokens and cost —
 * never the state itself (it can hold member or business content).
 *
 * Also keeps in-process counters since boot for GET /api/v1/jev/admin/stats,
 * so the plane split is visible before any dashboard exists. Counters are per
 * task and reset on deploy; OASIS is the durable record.
 */

import { emitOasisEvent } from '../oasis-event-service';
import { MODEL_COSTS, modelCostKey } from '../../constants/llm-defaults';
import type { JevPlane } from './jev-access';

export const JEV_TELEMETRY_VTID = 'VTID-04473';

export type JevOutcome = 'decided' | 'abstained' | 'fallback' | 'failed';

export interface JevDecisionTelemetry {
  decision: string;
  outcome: JevOutcome;
  plane: JevPlane;
  role: string;
  actor_id: string;
  tenant_id?: string | null;
  source: string;
  model?: string;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  confidence?: number | null;
  reason?: string;
  items?: number;
  redactions?: number;
}

/**
 * Unrounded on purpose: one document costs ~$0.00003, so estimateCost()'s
 * 6-decimal rounding would misprice a 10,000-document search by several percent.
 */
export function jevCostUsd(model: string, inputTokens: number): number {
  const key = modelCostKey(model);
  const rate = key ? MODEL_COSTS[key].input : 0;
  return (inputTokens / 1_000_000) * rate;
}

interface Bucket {
  calls: number;
  decided: number;
  abstained: number;
  fallback: number;
  failed: number;
  input_tokens: number;
  cost_usd: number;
}

const emptyBucket = (): Bucket => ({ calls: 0, decided: 0, abstained: 0, fallback: 0, failed: 0, input_tokens: 0, cost_usd: 0 });

const stats = {
  since: new Date().toISOString(),
  total: emptyBucket(),
  by_plane: {} as Record<string, Bucket>,
  by_decision: {} as Record<string, Bucket>,
  by_role: {} as Record<string, Bucket>,
};

function bump(b: Bucket, t: JevDecisionTelemetry): void {
  b.calls++;
  b[t.outcome]++;
  b.input_tokens += t.input_tokens;
  b.cost_usd = Math.round((b.cost_usd + t.cost_usd) * 1e8) / 1e8;
}

export function recordJevStats(t: JevDecisionTelemetry): void {
  bump(stats.total, t);
  bump((stats.by_plane[t.plane] ||= emptyBucket()), t);
  bump((stats.by_decision[t.decision] ||= emptyBucket()), t);
  bump((stats.by_role[t.role] ||= emptyBucket()), t);
}

export function getJevStats() {
  return JSON.parse(JSON.stringify(stats));
}

export function resetJevStatsForTest(): void {
  stats.since = new Date().toISOString();
  stats.total = emptyBucket();
  stats.by_plane = {};
  stats.by_decision = {};
  stats.by_role = {};
}

/** Fire-and-forget. Telemetry must never fail or slow a decision. */
export function emitJevDecisionEvent(t: JevDecisionTelemetry): void {
  recordJevStats(t);
  const type =
    t.outcome === 'failed' ? 'jev.decision.failed' : t.outcome === 'fallback' ? 'jev.decision.fallback' : 'jev.decision.completed';
  const status = t.outcome === 'failed' ? 'error' : t.outcome === 'fallback' ? 'warning' : 'success';
  void emitOasisEvent({
    vtid: JEV_TELEMETRY_VTID,
    type,
    source: `jev:${t.source}`,
    status,
    message: `jev ${t.decision} ${t.outcome}${t.reason ? ` (${t.reason})` : ''} plane=${t.plane} role=${t.role}`,
    payload: { ...t },
    actor_id: t.actor_id,
    actor_role: t.role === 'system' ? 'system' : t.plane === 'internal' ? 'operator' : 'user',
    surface: 'api',
  }).catch((err) => {
    console.warn('[jev] telemetry emit failed:', err?.message || err);
  });
}
