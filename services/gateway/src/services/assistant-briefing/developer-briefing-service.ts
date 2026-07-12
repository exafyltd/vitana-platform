/**
 * Developer briefing service (VTID-ASSISTANT-ROLES).
 *
 * Builds the session-opening briefing for the DEVELOPER assistant lane
 * (Command Hub surface): status → since-last-session → ranked immediate
 * attention → single recommended next step.
 *
 * Fan-in sources (each timeout-bounded, degrades gracefully):
 *   - self_healing_log            pending diagnoses awaiting human approval
 *   - vtid_ledger                 active self-healing tasks + 24h terminalizations
 *   - autopilot_recommendations   new dev-autopilot findings
 *   - dev_autopilot_executions    executions in flight / recently failed
 *   - test_contracts              failing / quarantined contracts
 *   - /api/v1/approvals           pending PR approvals (gateway self-call)
 *   - system controls             the three governance kill-switch states
 *   - agents_registry             down/degraded agents
 *   - oasis_events                error-status events in the window
 *
 * Ranking is deterministic and lives HERE (unit-testable), never in the
 * prompt. All strings are LLM/system-prompt or developer-facing content —
 * English by design (CLAUDE.md §13b).
 */

import { getSupabase } from '../../lib/supabase';
import {
  briefingSource,
  relAgeShort,
  type AttentionItem,
  type BriefingEnvelope,
  type BriefingItem,
  type NextStep,
} from './briefing-types';
import { getCachedBriefing, setCachedBriefing } from './briefing-cache';

const EXECUTION_INFLIGHT_STATUSES = ['cooling', 'running', 'ci', 'merging', 'deploying', 'verifying'];
const HEALING_ACTIVE_STATUSES = ['allocated', 'pending', 'scheduled', 'in_progress', 'paused'];
const PENDING_HEAL_SLA_MS = 24 * 3600_000;

function gatewayBaseUrl(): string {
  return process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
}

interface DeveloperBriefingCounts {
  pendingHeals: { count: number; oldest: string | null; topEndpoint: string | null; topId: string | null };
  activeHealTasks: number;
  newFindings: { count: number; topTitle: string | null; topId: string | null };
  executions: { inflight: number; failed24h: number };
  failingContracts: { count: number; topCapability: string | null };
  approvals: { count: number; topVtid: string | null; topTitle: string | null };
  controls: { executionArmed: boolean | null; allocatorEnabled: boolean | null };
  agents: { down: number; degraded: number; total: number; topDown: string | null };
  terminalized: { total: number; success: number };
  errorEvents: { count: number; topMessage: string | null };
}

async function collectCounts(sinceIso: string | null, degraded: string[]): Promise<DeveloperBriefingCounts> {
  const sb = getSupabase();
  const windowStart = sinceIso || new Date(Date.now() - 24 * 3600_000).toISOString();

  const counts: DeveloperBriefingCounts = {
    pendingHeals: { count: 0, oldest: null, topEndpoint: null, topId: null },
    activeHealTasks: 0,
    newFindings: { count: 0, topTitle: null, topId: null },
    executions: { inflight: 0, failed24h: 0 },
    failingContracts: { count: 0, topCapability: null },
    approvals: { count: 0, topVtid: null, topTitle: null },
    controls: { executionArmed: null, allocatorEnabled: null },
    agents: { down: 0, degraded: 0, total: 0, topDown: null },
    terminalized: { total: 0, success: 0 },
    errorEvents: { count: 0, topMessage: null },
  };

  if (!sb) {
    degraded.push('database');
    return counts;
  }

  await Promise.all([
    briefingSource('self_healing_pending', degraded, null, (async () => {
      const { data, error } = await sb
        .from('self_healing_log')
        .select('id, endpoint, created_at')
        .eq('outcome', 'pending')
        .order('created_at', { ascending: true })
        .limit(50);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.pendingHeals.count = rows.length;
      counts.pendingHeals.oldest = rows[0]?.created_at ?? null;
      counts.pendingHeals.topEndpoint = rows[0]?.endpoint ?? null;
      counts.pendingHeals.topId = rows[0]?.id ?? null;
      return null;
    })()),
    briefingSource('self_healing_active', degraded, null, (async () => {
      const { count, error } = await sb
        .from('vtid_ledger')
        .select('vtid', { count: 'exact', head: true })
        .filter('metadata->>source', 'eq', 'self-healing')
        .in('status', HEALING_ACTIVE_STATUSES);
      if (error) throw new Error(error.message);
      counts.activeHealTasks = count ?? 0;
      return null;
    })()),
    briefingSource('autopilot_findings', degraded, null, (async () => {
      const { data, error } = await sb
        .from('autopilot_recommendations')
        .select('id, title')
        .in('source_type', ['dev_autopilot', 'dev_autopilot_impact'])
        .eq('status', 'new')
        .order('impact_score', { ascending: false, nullsFirst: false })
        .limit(50);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.newFindings.count = rows.length;
      counts.newFindings.topTitle = rows[0]?.title ?? null;
      counts.newFindings.topId = rows[0]?.id ?? null;
      return null;
    })()),
    briefingSource('executions', degraded, null, (async () => {
      const [inflightRes, failedRes] = await Promise.all([
        sb
          .from('dev_autopilot_executions')
          .select('id', { count: 'exact', head: true })
          .in('status', EXECUTION_INFLIGHT_STATUSES),
        sb
          .from('dev_autopilot_executions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'failed')
          .gte('updated_at', windowStart),
      ]);
      if (inflightRes.error) throw new Error(inflightRes.error.message);
      counts.executions.inflight = inflightRes.count ?? 0;
      counts.executions.failed24h = failedRes.error ? 0 : (failedRes.count ?? 0);
      return null;
    })()),
    briefingSource('test_contracts', degraded, null, (async () => {
      const { data, error } = await sb
        .from('test_contracts')
        .select('capability')
        .in('status', ['fail', 'quarantined'])
        .order('last_run_at', { ascending: false, nullsFirst: false })
        .limit(50);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.failingContracts.count = rows.length;
      counts.failingContracts.topCapability = rows[0]?.capability ?? null;
      return null;
    })()),
    briefingSource('approvals', degraded, null, (async () => {
      const res = await fetch(`${gatewayBaseUrl()}/api/v1/approvals/pending?limit=5`);
      const body = (await res.json()) as { ok?: boolean; items?: Array<{ vtid?: string; title?: string }> };
      if (!res.ok || body.ok !== true) throw new Error(`approvals ${res.status}`);
      const items = Array.isArray(body.items) ? body.items : [];
      counts.approvals.count = items.length;
      counts.approvals.topVtid = items[0]?.vtid ?? null;
      counts.approvals.topTitle = items[0]?.title ?? null;
      return null;
    })()),
    briefingSource('governance_controls', degraded, null, (async () => {
      const { isAutopilotExecutionArmed, isVtidAllocatorEnabled } = await import('../system-controls-service');
      const [armed, allocator] = await Promise.all([
        isAutopilotExecutionArmed(),
        isVtidAllocatorEnabled(),
      ]);
      counts.controls.executionArmed = armed;
      counts.controls.allocatorEnabled = allocator;
      return null;
    })()),
    briefingSource('agents', degraded, null, (async () => {
      const { data, error } = await sb
        .from('agents_registry')
        .select('agent_id, display_name, tier, status, last_heartbeat_at, llm_provider');
      if (error) throw new Error(error.message);
      const { deriveAgentStatus } = await import('../orb-tools/developer-tools');
      const rows = (data ?? []).map((r: any) => ({ ...r, derived: deriveAgentStatus(r) }));
      counts.agents.total = rows.length;
      counts.agents.down = rows.filter((r) => r.derived === 'down').length;
      counts.agents.degraded = rows.filter((r) => r.derived === 'degraded').length;
      const firstDown = rows.find((r) => r.derived === 'down');
      counts.agents.topDown = firstDown ? (firstDown.display_name || firstDown.agent_id) : null;
      return null;
    })()),
    briefingSource('terminalized', degraded, null, (async () => {
      const { data, error } = await sb
        .from('vtid_ledger')
        .select('terminal_outcome')
        .eq('is_terminal', true)
        .gte('updated_at', windowStart)
        .limit(100);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.terminalized.total = rows.length;
      counts.terminalized.success = rows.filter((r: any) => r.terminal_outcome === 'success').length;
      return null;
    })()),
    briefingSource('error_events', degraded, null, (async () => {
      const { data, error } = await sb
        .from('oasis_events')
        .select('message')
        .eq('status', 'error')
        .gte('created_at', windowStart)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.errorEvents.count = rows.length;
      counts.errorEvents.topMessage = rows[0]?.message ?? null;
      return null;
    })()),
  ]);

  return counts;
}

/**
 * Deterministic attention ranking. Higher rank = spoken first.
 * Exported for unit tests.
 */
export function rankDeveloperAttention(c: DeveloperBriefingCounts): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (c.agents.down > 0) {
    items.push({
      source: 'agents',
      severity: 'critical',
      rank: 95,
      line: `${c.agents.down} agent${c.agents.down === 1 ? ' is' : 's are'} DOWN${c.agents.topDown ? ` (${c.agents.topDown})` : ''} — the platform is running without ${c.agents.down === 1 ? 'it' : 'them'}.`,
      action_hint: 'dev_list_agents',
    });
  }

  if (c.pendingHeals.count > 0) {
    const slaBreach = !!c.pendingHeals.oldest
      && Date.now() - new Date(c.pendingHeals.oldest).getTime() > PENDING_HEAL_SLA_MS;
    items.push({
      source: 'self_healing',
      severity: slaBreach ? 'critical' : 'warning',
      rank: slaBreach ? 92 : 88,
      oldest_at: c.pendingHeals.oldest,
      sla_breach: slaBreach,
      line: `${c.pendingHeals.count} self-healing fix${c.pendingHeals.count === 1 ? '' : 'es'} waiting for your approval` +
        (c.pendingHeals.topEndpoint ? ` — oldest targets ${c.pendingHeals.topEndpoint} (${relAgeShort(c.pendingHeals.oldest)} old)` : '') +
        (slaBreach ? '. That one is past the 24-hour mark.' : '.'),
      action_hint: 'dev_list_pending_heals',
      data: { top_id: c.pendingHeals.topId },
    });
  }

  if (c.approvals.count > 0) {
    items.push({
      source: 'approvals',
      severity: 'warning',
      rank: 80,
      line: `${c.approvals.count} PR${c.approvals.count === 1 ? '' : 's'} in the approvals queue` +
        (c.approvals.topVtid ? ` — top: ${c.approvals.topVtid} "${c.approvals.topTitle ?? ''}".` : '.'),
      action_hint: 'dev_list_pending_approvals',
    });
  }

  if (c.executions.failed24h > 0) {
    items.push({
      source: 'executions',
      severity: 'warning',
      rank: 78,
      line: `${c.executions.failed24h} autopilot execution${c.executions.failed24h === 1 ? '' : 's'} failed in the window — worth a look before re-driving anything.`,
      action_hint: 'dev_list_executions',
    });
  }

  if (c.failingContracts.count > 0) {
    items.push({
      source: 'test_contracts',
      severity: c.failingContracts.count > 3 ? 'critical' : 'warning',
      rank: c.failingContracts.count > 3 ? 84 : 72,
      line: `${c.failingContracts.count} test contract${c.failingContracts.count === 1 ? ' is' : 's are'} failing or quarantined` +
        (c.failingContracts.topCapability ? ` (latest: ${c.failingContracts.topCapability})` : '') + '.',
      action_hint: 'dev_list_test_runs',
    });
  }

  if (c.controls.executionArmed === false) {
    items.push({
      source: 'governance',
      severity: 'warning',
      rank: 70,
      line: 'Autopilot execution is DISARMED — autonomous execution is halted; monitor-only mode until a human re-arms it in the Command Hub.',
      action_hint: 'dev_get_governance_controls',
    });
  }

  if (c.controls.allocatorEnabled === false) {
    items.push({
      source: 'governance',
      severity: 'info',
      rank: 55,
      line: 'The VTID allocator is disabled — no new VTIDs can be minted until it is re-enabled.',
      action_hint: 'dev_get_governance_controls',
    });
  }

  if (c.errorEvents.count > 0) {
    items.push({
      source: 'oasis_errors',
      severity: c.errorEvents.count >= 10 ? 'warning' : 'info',
      rank: c.errorEvents.count >= 10 ? 66 : 50,
      line: `${c.errorEvents.count} error event${c.errorEvents.count === 1 ? '' : 's'} in OASIS during the window` +
        (c.errorEvents.topMessage ? ` — most recent: "${String(c.errorEvents.topMessage).slice(0, 120)}".` : '.'),
      action_hint: 'dev_get_autonomy_pulse',
    });
  }

  return items.sort((a, b) => b.rank - a.rank);
}

/** Map the top attention item to the single recommended next step. */
export function deriveDeveloperNextStep(attention: AttentionItem[], c: DeveloperBriefingCounts): NextStep | null {
  const top = attention[0];
  if (!top) {
    if (c.newFindings.count > 0) {
      return {
        recommendation: `Nothing is on fire. The autopilot has ${c.newFindings.count} new finding${c.newFindings.count === 1 ? '' : 's'} waiting — I suggest we review the top one${c.newFindings.topTitle ? ` ("${c.newFindings.topTitle}")` : ''} and decide whether to plan it.`,
        tool: 'dev_list_findings',
        args_template: {},
        tier: 0,
      };
    }
    return {
      recommendation: 'Everything is green and the queues are empty. I suggest a quick autonomy pulse check, or tell me what you want to build.',
      tool: 'dev_get_autonomy_pulse',
      args_template: {},
      tier: 0,
    };
  }
  switch (top.source) {
    case 'self_healing':
      return {
        recommendation: 'Review the oldest pending self-healing fix — I can read you the diagnosis and take your approve/reject decision.',
        tool: 'dev_list_pending_heals',
        args_template: {},
        tier: 0,
      };
    case 'approvals':
      return {
        recommendation: `Clear the approvals queue — say "list approvals" and we go through ${c.approvals.count === 1 ? 'it' : 'them'} one by one.`,
        tool: 'dev_list_pending_approvals',
        args_template: {},
        tier: 0,
      };
    case 'agents':
      return {
        recommendation: 'Check which agents are down and why — I can list them with heartbeat ages.',
        tool: 'dev_list_agents',
        args_template: {},
        tier: 0,
      };
    case 'executions':
      return {
        recommendation: 'Look at the failed executions before re-driving anything — I can list them with their failure states.',
        tool: 'dev_list_executions',
        args_template: { status: 'failed' },
        tier: 0,
      };
    case 'test_contracts':
      return {
        recommendation: 'Inspect the failing test contracts — I can list recent runs and trigger a re-run once you have seen them.',
        tool: 'dev_list_test_runs',
        args_template: {},
        tier: 0,
      };
    default:
      return {
        recommendation: 'Check the governance control panel state first — nothing autonomous moves while a kill switch is engaged.',
        tool: 'dev_get_governance_controls',
        args_template: {},
        tier: 0,
      };
  }
}

/**
 * Build the developer briefing envelope. `sinceIso` = last session time
 * (drives the since-last-session window); null falls back to 24 h.
 */
export async function buildDeveloperBriefing(sinceIso: string | null): Promise<BriefingEnvelope> {
  const cacheKey = `developer:${sinceIso ?? '24h'}`;
  const cached = getCachedBriefing(cacheKey);
  if (cached) return cached;

  const degraded: string[] = [];
  const c = await collectCounts(sinceIso, degraded);
  const attention = rankDeveloperAttention(c);
  const nextStep = deriveDeveloperNextStep(attention, c);

  const statusItems: BriefingItem[] = [
    {
      source: 'governance',
      line: c.controls.executionArmed === null
        ? 'Governance control state could not be checked.'
        : `Governance: autopilot execution ${c.controls.executionArmed ? 'ARMED' : 'DISARMED'}, VTID allocator ${c.controls.allocatorEnabled ? 'enabled' : 'disabled'}.`,
    },
    {
      source: 'autonomy',
      line: `Autonomy: ${c.executions.inflight} execution${c.executions.inflight === 1 ? '' : 's'} in flight, ${c.activeHealTasks} self-healing task${c.activeHealTasks === 1 ? '' : 's'} active, ${c.newFindings.count} new finding${c.newFindings.count === 1 ? '' : 's'} queued.`,
    },
    {
      source: 'agents',
      line: c.agents.total > 0
        ? `Agents: ${c.agents.total - c.agents.down - c.agents.degraded} healthy, ${c.agents.degraded} degraded, ${c.agents.down} down.`
        : 'Agents: registry empty or unavailable.',
    },
  ];

  const healthy = attention.filter((a) => a.severity !== 'info').length === 0;
  const headline = healthy
    ? 'Platform is green — no critical items.'
    : `${attention.filter((a) => a.severity === 'critical').length} critical and ${attention.filter((a) => a.severity === 'warning').length} warning item${attention.length === 1 ? '' : 's'} need attention.`;

  const sinceItems: BriefingItem[] = [
    {
      source: 'throughput',
      line: `${c.terminalized.total} VTID${c.terminalized.total === 1 ? '' : 's'} terminalized (${c.terminalized.success} succeeded)${c.executions.failed24h ? `, ${c.executions.failed24h} execution${c.executions.failed24h === 1 ? '' : 's'} failed` : ''}.`,
    },
    {
      source: 'oasis_errors',
      line: c.errorEvents.count === 0
        ? 'No error events in OASIS during the window.'
        : `${c.errorEvents.count} error event${c.errorEvents.count === 1 ? '' : 's'} logged.`,
    },
  ];

  const envelope: BriefingEnvelope = {
    ok: true,
    role: 'developer',
    generated_at: new Date().toISOString(),
    status: { headline, items: statusItems },
    since_last_session: { since: sinceIso, items: sinceItems },
    attention: { items: attention },
    next_step: nextStep,
    degraded_sources: degraded,
  };

  setCachedBriefing(cacheKey, envelope);
  return envelope;
}

/**
 * Render the envelope as the `## CURRENT BRIEFING` system-instruction block
 * consumed by the BRIEFING-FIRST OPENING rule in live-system-instruction.ts.
 */
export function renderDeveloperBriefingBlock(env: BriefingEnvelope): string {
  const lines: string[] = [];
  lines.push('## CURRENT BRIEFING (DEVELOPER — generated at session start)');
  lines.push('Deliver this as your opening per the BRIEFING-FIRST OPENING rule. Ground every number below; do not invent any.');
  lines.push('');
  lines.push(`STATUS: ${env.status.headline}`);
  for (const item of env.status.items) lines.push(`- ${item.line}`);
  lines.push('');
  lines.push(`SINCE LAST SESSION${env.since_last_session.since ? ` (since ${env.since_last_session.since})` : ' (last 24 h)'}:`);
  for (const item of env.since_last_session.items) lines.push(`- ${item.line}`);
  lines.push('');
  if (env.attention.items.length > 0) {
    lines.push('IMMEDIATE ATTENTION (ranked, speak the top 1-3):');
    for (const item of env.attention.items.slice(0, 5)) {
      lines.push(`- [${item.severity.toUpperCase()}] ${item.line}${item.action_hint ? ` (tool: ${item.action_hint})` : ''}`);
    }
  } else {
    lines.push('IMMEDIATE ATTENTION: nothing urgent.');
  }
  lines.push('');
  if (env.next_step) {
    lines.push(`RECOMMENDED NEXT STEP: ${env.next_step.recommendation}${env.next_step.tool ? ` (tool: ${env.next_step.tool})` : ''}`);
  }
  if (env.degraded_sources.length > 0) {
    lines.push('');
    lines.push(`DEGRADED SOURCES (say honestly you could not check these): ${env.degraded_sources.join(', ')}`);
  }
  return lines.join('\n');
}
