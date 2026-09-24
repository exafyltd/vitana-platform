/**
 * VTID-04510 (Community Autopilot CA-8): the automation supervisor.
 *
 * One read-only picture of the community automation engine, for the Command
 * Hub and for an operator: which delivery mode the gateway runs in, what each
 * automation did in the window (runs, outcomes), what the proposing
 * automations put in members' queues and what members did with it, and which
 * automations still act without a suggestion.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTOMATION_SOURCE_PREFIX, PROPOSING_AUTOMATIONS, REMAINING_SILENT_ACTORS } from './automation-proposals';

export const SUPERVISOR_WINDOW_DAYS_DEFAULT = 7;
export const SUPERVISOR_WINDOW_DAYS_MAX = 30;

export interface RunRow { automation_id: string; status: string; users_affected?: number | null; actions_taken?: number | null }
export interface ProposalRow { status: string; provenance: any; source_ref?: string | null }

export interface AutomationSupervisorRow {
  automation_id: string;
  name: string | null;
  status: string | null;
  runs: Record<string, number>;
  users_affected: number;
  actions_taken: number;
  proposals: Record<string, number>;
  mode: 'proposes' | 'acts_silently' | 'other';
}

export function clampWindowDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SUPERVISOR_WINDOW_DAYS_DEFAULT;
  return Math.min(SUPERVISOR_WINDOW_DAYS_MAX, Math.floor(n));
}

/** Pure: fold runs and proposals into one row per automation. */
export function summarizeSupervisor(a: {
  runs: RunRow[];
  proposals: ProposalRow[];
  registry: Array<{ id: string; name: string; status: string }>;
}): { automations: AutomationSupervisorRow[]; totals: { runs: number; proposals: Record<string, number> } } {
  const byId = new Map<string, AutomationSupervisorRow>();
  const reg = new Map(a.registry.map((r) => [r.id, r]));
  const row = (id: string): AutomationSupervisorRow => {
    let r = byId.get(id);
    if (!r) {
      const def = reg.get(id);
      r = {
        automation_id: id,
        name: def?.name ?? null,
        status: def?.status ?? null,
        runs: {},
        users_affected: 0,
        actions_taken: 0,
        proposals: {},
        mode: PROPOSING_AUTOMATIONS.includes(id) ? 'proposes' : REMAINING_SILENT_ACTORS.includes(id) ? 'acts_silently' : 'other',
      };
      byId.set(id, r);
    }
    return r;
  };
  for (const id of [...PROPOSING_AUTOMATIONS, ...REMAINING_SILENT_ACTORS]) row(id);

  for (const run of a.runs) {
    if (!run.automation_id) continue;
    const r = row(run.automation_id);
    r.runs[run.status] = (r.runs[run.status] ?? 0) + 1;
    r.users_affected += Number(run.users_affected ?? 0);
    r.actions_taken += Number(run.actions_taken ?? 0);
  }
  const proposalTotals: Record<string, number> = {};
  for (const p of a.proposals) {
    const id = p?.provenance?.automation_id;
    if (typeof id !== 'string' || !id) continue;
    const r = row(id);
    r.proposals[p.status] = (r.proposals[p.status] ?? 0) + 1;
    proposalTotals[p.status] = (proposalTotals[p.status] ?? 0) + 1;
  }
  const automations = [...byId.values()].sort((x, y) => x.automation_id.localeCompare(y.automation_id));
  return { automations, totals: { runs: a.runs.length, proposals: proposalTotals } };
}

export async function loadSupervisor(sb: SupabaseClient, opts: { windowDays: number; tenantId?: string | null; now?: Date }) {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.windowDays * 86400_000).toISOString();
  let runsQ = sb.from('automation_runs')
    .select('automation_id,status,users_affected,actions_taken')
    .gte('created_at', since)
    .limit(5000);
  if (opts.tenantId) runsQ = runsQ.eq('tenant_id', opts.tenantId);
  const proposalsQ = sb.from('autopilot_recommendations')
    .select('status,provenance,source_ref')
    .like('source_ref', `${AUTOMATION_SOURCE_PREFIX}%`)
    .gte('created_at', since)
    .limit(5000);
  const [runs, proposals] = await Promise.all([runsQ, proposalsQ]);
  const errors = [runs.error, proposals.error].filter(Boolean).map((e: any) => e.message);
  const { AUTOMATION_REGISTRY } = await import('../automation-registry');
  const { resolveAutomationDeliveryMode } = await import('../automation-shadow');
  const summary = summarizeSupervisor({
    runs: (runs.data as RunRow[]) ?? [],
    proposals: (proposals.data as ProposalRow[]) ?? [],
    registry: AUTOMATION_REGISTRY.map((d: any) => ({ id: d.id, name: d.name, status: d.status })),
  });
  return {
    window_days: opts.windowDays,
    since,
    tenant_id: opts.tenantId ?? null,
    delivery_mode: resolveAutomationDeliveryMode(),
    ...summary,
    errors,
  };
}
