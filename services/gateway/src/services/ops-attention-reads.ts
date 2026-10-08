/**
 * VTID-04876 — production data access for the /ops/attention adapters.
 *
 * Every read is in-process (plan REVISION 2 F3): the Phase 1a builders
 * (buildHealthSummary, buildVoiceOverview), the Dev
 * Autopilot supervisor snapshot, the system-controls service, the approvals
 * helpers, the ops-runtime build-info checks, and small bounded
 * service-role reads (supabase-js) with a LIMIT and an indexed filter
 * (topic + created_at, status, outcome). Nothing here makes an HTTP call to
 * this gateway's own routes. VTID-04987: cloudwatchAlarms() is the one AWS
 * read (DescribeAlarms, ops-attention-cloudwatch.ts).
 *
 * Every function throws on a failed read — the aggregator maps a throw to
 * an UNKNOWN source — and never turns "could not read" into "nothing found".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VitanaEnv } from '../env';
import { getSupabase } from '../lib/supabase';
import { buildHealthSummary } from './health-summary-builder';
import { buildVoiceOverview } from './voice-supervisor-overview';
import { buildSupervisorSnapshot } from './dev-autopilot-supervisor';
import { getAllSystemControls } from './system-controls-service';
import { isAutonomousExecutionTask } from '../routes/worker-orchestrator';
import { fetchApprovalEligibleVtids, fetchPrInfoForVtids } from '../routes/approvals';
import { runRuntimeCheckCached } from '../routes/ops-runtime-health';
import { aggregateSpend, budgetLines, loadSpendToday } from './orchestrator/budgets';
import { describeAlarmsInAlarm } from './ops-attention-cloudwatch';
import {
  GOOGLE_LLM_PROVIDERS,
  JEV_BUDGET_TOPIC,
  LEDGER_READ_LIMIT,
  TICKET_CLOSED_STATUSES,
  TIMELINE_READ_LIMIT,
  SELF_HEAL_READ_LIMIT,
  TIMELINE_TOPICS,
  type AttentionReads,
  type ControlRow,
  type LedgerRow,
  type WaitingRow,
} from './ops-attention-adapters';
import type { AckRow, AttentionAckStore, AttentionStateStore, StateRow } from './ops-attention';

/** Same threshold as the pipeline summary's BROKEN classification. */
const PIPELINE_BROKEN_AFTER_MS = 2 * 60 * 60_000;

function sb(): SupabaseClient {
  const client = getSupabase();
  if (!client) throw new Error('supabase_unconfigured');
  return client;
}

function check<T>(res: { data: T | null; error: { message: string } | null }, table: string): T {
  if (res.error) throw new Error(`${table}: ${res.error.message}`);
  return (res.data ?? ([] as unknown)) as T;
}

export function createAttentionReads(opts: { authHeader?: string } = {}): AttentionReads {
  // VTID-04885: operator_pipeline and stuck_vtids read the same in-progress
  // ledger page; one read per computation serves both.
  let ledger: Promise<LedgerRow[]> | null = null;
  // VTID-04886: the autonomy adapter and the timeline read the same 24 h of
  // self_healing_log; one read per window per computation serves both.
  const heals = new Map<string, Promise<any[]>>();
  return {
    async healthSummary() {
      const s = await buildHealthSummary({ authHeader: opts.authHeader });
      return { checked_at: s.checked_at, items: s.items as any };
    },

    async latestEvent(topics, sinceIso) {
      const rows = check(
        await sb()
          .from('oasis_events')
          .select('topic,created_at,metadata')
          .in('topic', topics)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(1),
        'oasis_events',
      ) as any[];
      return rows[0] ?? null;
    },

    async buildInfo(which) {
      return (await runRuntimeCheckCached(which === 'prod' ? 'deploy/prod-gateway' : 'deploy/staging-gateway')) as any;
    },

    async voiceOverview() {
      const o = await buildVoiceOverview({ window: '1h', scope: { is_platform_admin: true } });
      return { verdict_summary: o.verdict_summary, verdicts: o.verdicts as any, window: o.window, generated_at: o.generated_at, truncated: o.truncated === true };
    },

    async voiceQuarantines() {
      return check(
        await sb()
          .from('voice_healing_quarantine')
          .select('class,quarantined_at,reason')
          .eq('status', 'quarantined')
          .order('quarantined_at', { ascending: false })
          .limit(50),
        'voice_healing_quarantine',
      ) as any[];
    },

    async voiceArchitectureReports() {
      const rows = check(
        await sb()
          .from('voice_architecture_reports')
          .select('id,class,generated_at,report')
          .eq('status', 'open')
          .order('generated_at', { ascending: false })
          .limit(50),
        'voice_architecture_reports',
      ) as Array<{ id: string; class: string; generated_at: string; report: any }>;
      return rows
        .map((r) => ({ id: r.id, class: r.class, generated_at: r.generated_at, track: String(r.report?.recommendation?.track ?? '') }))
        .filter((r) => r.track && r.track.toLowerCase() !== 'stay_and_patch');
    },

    async supervisorAlerts() {
      const readErrors: string[] = [];
      const snap: any = await buildSupervisorSnapshot(Date.now(), { readErrors });
      if (!snap || snap.ok === false) throw new Error(`dev_autopilot_supervisor: ${snap?.error || 'unavailable'}`);
      // The snapshot substitutes [] for a failed subordinate read; its alerts
      // would then look clear. Any failed read makes the source UNKNOWN.
      if (readErrors.length) throw new Error(`dev_autopilot_supervisor: failed reads: ${[...new Set(readErrors)].join(', ')}`);
      return Array.isArray(snap.alerts) ? snap.alerts : [];
    },

    selfHealOutcomes(sinceIso) {
      let p = heals.get(sinceIso);
      if (!p) {
        p = (async () =>
          check(
            await sb()
              .from('self_healing_log')
              .select('vtid,endpoint,failure_class,outcome,created_at')
              .in('outcome', ['escalated', 'rolled_back'])
              .gte('created_at', sinceIso)
              .order('created_at', { ascending: false })
              .limit(SELF_HEAL_READ_LIMIT),
            'self_healing_log',
          ) as any[])();
        heals.set(sinceIso, p);
        p.catch(() => heals.delete(sinceIso));
      }
      return p;
    },

    async pipelineBrokenVtids() {
      // The pipeline summary's BROKEN heuristic (in progress, no ledger update
      // for more than 2 h), read directly: buildPipelineSummary() swallows a
      // failed stuck query and returns an empty set with status 200, which
      // would read as "nothing broken". This read throws instead.
      const cutoff = new Date(Date.now() - PIPELINE_BROKEN_AFTER_MS).toISOString();
      const rows = check(
        await sb()
          .from('vtid_ledger')
          .select('vtid')
          .like('vtid', 'VTID-%')
          .eq('status', 'in_progress')
          .lt('updated_at', cutoff)
          .limit(200),
        'vtid_ledger',
      ) as Array<{ vtid: string }>;
      return rows.map((r) => String(r.vtid));
    },

    inProgressLedger() {
      if (!ledger) {
        ledger = (async () =>
          check(
            await sb()
              .from('vtid_ledger')
              .select('vtid,title,metadata,claimed_by,claim_started_at,claim_expires_at,updated_at')
              .like('vtid', 'VTID-%')
              .eq('status', 'in_progress')
              .or('is_terminal.is.null,is_terminal.eq.false')
              .limit(LEDGER_READ_LIMIT),
            'vtid_ledger',
          ) as LedgerRow[])();
        // A failed read is not cached: the next caller retries.
        ledger.catch(() => { ledger = null; });
      }
      return ledger;
    },

    isAutonomous(row: LedgerRow) {
      return isAutonomousExecutionTask(row as { metadata?: any });
    },

    async systemControls() {
      const rows = await getAllSystemControls();
      // getAllSystemControls() returns [] on any failure; system_controls is
      // never legitimately empty, so an empty list is "could not read".
      if (!rows.length) throw new Error('system_controls: unreadable or empty');
      const out: ControlRow[] = rows.map((c) => ({
        key: c.key,
        enabled: c.enabled,
        reason: c.reason ?? null,
        updated_by: c.updated_by,
        updated_at: c.updated_at,
      }));
      // Same effective semantics as isVtidAllocatorEnabled(): the env var
      // wins, and a missing control row means disabled.
      const alloc = out.find((c) => c.key === 'vtid_allocator_enabled');
      if ((process.env.VTID_ALLOCATOR_ENABLED ?? 'false') === 'true') {
        if (alloc) alloc.enabled = true;
      } else if (!alloc) {
        out.push({ key: 'vtid_allocator_enabled', enabled: false, reason: 'control row missing', updated_by: null, updated_at: null });
      }
      // isAutopilotExecutionArmed(): a missing row means ARMED — nothing to add.
      return out;
    },

    async devAutopilotKillSwitch() {
      const rows = check(
        await sb().from('dev_autopilot_config').select('kill_switch').eq('id', 1).limit(1),
        'dev_autopilot_config',
      ) as Array<{ kill_switch?: boolean }>;
      return rows[0] ? { engaged: rows[0].kill_switch === true } : null;
    },

    async openViolations() {
      const rows = check(
        await sb()
          .from('governance_violations')
          .select('id,severity,status,created_at,governance_rules(logic)')
          .eq('tenant_id', 'SYSTEM')
          .eq('status', 'OPEN')
          .order('created_at', { ascending: false })
          .limit(200),
        'governance_violations',
      ) as any[];
      return rows.map((v) => ({
        id: String(v.id),
        severity: Number(v.severity) || 0,
        status: String(v.status),
        created_at: v.created_at,
        rule_code: v.governance_rules?.logic?.rule_code ?? null,
      }));
    },

    async devAutopilotAwaitingApproval() {
      const rows = check(
        await sb()
          .from('dev_autopilot_executions')
          .select('id,updated_at')
          .eq('status', 'awaiting_approval')
          .order('updated_at', { ascending: true })
          .limit(200),
        'dev_autopilot_executions',
      ) as Array<{ id: string; updated_at: string }>;
      return rows.map((r): WaitingRow => ({ id: String(r.id), waiting_since: r.updated_at }));
    },

    async selfHealPendingApproval() {
      // Same filter as GET /api/v1/self-healing/pending-approval.
      const rows = check(
        await sb()
          .from('self_healing_log')
          .select('id,vtid,endpoint,created_at,diagnosis')
          .eq('outcome', 'pending')
          .lt('confidence', 0.8)
          .neq('failure_class', 'dev_autopilot_self_heal_in_progress')
          .order('created_at', { ascending: false })
          .limit(200),
        'self_healing_log',
      ) as any[];
      return rows
        .filter((r) => !(r.diagnosis && r.diagnosis.human_decision))
        .map((r): WaitingRow => ({ id: String(r.id), vtid: r.vtid, title: r.endpoint, waiting_since: r.created_at }));
    },

    async prApprovalsPending() {
      // Same set as GET /api/v1/approvals/pending (VTID-01148).
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE;
      if (!url || !key) throw new Error('supabase_unconfigured');
      const rows = await fetchApprovalEligibleVtids(url, key, 200);
      if (!rows.length) return [];
      const info = await fetchPrInfoForVtids(url, key, rows.map((r) => r.vtid));
      return rows
        .filter((r) => {
          const i = info.get(r.vtid);
          return !!(i && (i.head_branch || i.pr_number));
        })
        .map((r): WaitingRow => ({
          id: r.vtid,
          vtid: r.vtid,
          title: (r as any).title || r.description || r.vtid,
          waiting_since: r.updated_at,
        }));
    },

    // ── VTID-04885 (Phase 2) ──

    async llmBudgetLines() {
      // The same read and arithmetic as GET /api/v1/orchestrator/budgets.
      const { rows, since, truncated, error } = await loadSpendToday(sb());
      if (error) throw new Error(`oasis_events (llm.call.completed): ${error}`);
      return { since, truncated, lines: budgetLines(aggregateSpend(rows)) };
    },

    async jevBudgetAlerts(sinceIso) {
      return check(
        await sb()
          .from('oasis_events')
          .select('topic,created_at,metadata')
          .eq('topic', JEV_BUDGET_TOPIC)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(200),
        'oasis_events',
      ) as any[];
    },

    async ciTestRuns(sinceIso) {
      const [runs, syncState] = await Promise.all([
        sb()
          .from('ci_test_runs')
          .select('repo,workflow_file,workflow_name,branch,conclusion,html_url,run_created_at')
          .eq('branch', 'main')
          .gte('run_created_at', sinceIso)
          .order('run_created_at', { ascending: false })
          .limit(1000),
        sb().from('ci_test_sync_state').select('repo,last_synced_at').limit(10),
      ]);
      const rows = check(runs, 'ci_test_runs') as any[];
      const state = check(syncState, 'ci_test_sync_state') as Array<{ last_synced_at: string | null }>;
      // The OLDEST repository sync is the freshness of the whole read.
      const synced = state.map((r) => r.last_synced_at).filter((x): x is string => !!x).sort();
      return { rows, last_synced_at: state.length && synced.length === state.length ? synced[0] : null };
    },

    async failingTestContracts() {
      return check(
        await sb()
          .from('test_contracts')
          .select('id,capability,service,status,last_run_at,last_failure_signature')
          .eq('status', 'fail')
          .order('last_run_at', { ascending: false, nullsFirst: false })
          .limit(100),
        'test_contracts',
      ) as any[];
    },

    async routines() {
      return check(
        await sb()
          .from('routines')
          .select('name,display_name,cron_schedule,last_run_at,last_run_status,consecutive_failures,created_at')
          .eq('enabled', true)
          .limit(200),
        'routines',
      ) as any[];
    },

    async openSupportTickets(agedBeforeIso) {
      // Uses idx_feedback_tickets_priority_status (partial: open tickets only).
      const closed = `(${TICKET_CLOSED_STATUSES.join(',')})`;
      return check(
        await sb()
          .from('feedback_tickets')
          .select('id,ticket_number,kind,status,priority,created_at')
          .not('status', 'in', closed)
          .or(`priority.in.(p0,p1),created_at.lt.${agedBeforeIso}`)
          .order('created_at', { ascending: true })
          .limit(300),
        'feedback_tickets',
      ) as any[];
    },

    async llmGoogleCalls(sinceIso) {
      const rows = check(
        await sb()
          .from('oasis_events')
          .select('created_at,metadata')
          .eq('topic', 'llm.call.completed')
          .gte('created_at', sinceIso)
          // Provider OR a Gemini model: a Google landing can carry a legacy or
          // non-Google provider label; isGoogleLlmCall() makes the final call.
          .or(`metadata->>provider.in.(${GOOGLE_LLM_PROVIDERS.join(',')}),metadata->>model.ilike.gemini*`)
          .order('created_at', { ascending: false })
          .limit(500),
        'oasis_events',
      ) as Array<{ created_at: string; metadata: Record<string, unknown> | null }>;
      return rows.map((r) => {
        const m = r.metadata || {};
        return {
          created_at: r.created_at,
          provider: typeof m.provider === 'string' ? m.provider : null,
          model: typeof m.model === 'string' ? m.model : null,
          stage: typeof m.stage === 'string' ? m.stage : null,
          service: typeof m.service === 'string' ? m.service : null,
          fallback_used: m.fallback_used === true || m.fallback_used === 'true',
        };
      });
    },

    // ── VTID-04886 (Phase 3) ──

    async timelineEvents(sinceIso) {
      return check(
        await sb()
          .from('oasis_events')
          .select('topic,created_at,metadata')
          .in('topic', TIMELINE_TOPICS)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(TIMELINE_READ_LIMIT),
        'oasis_events',
      ) as any[];
    },

    // ── VTID-04987 ──

    async cloudwatchAlarms() {
      // DescribeAlarms(StateValue=ALARM), paginated, capped, 5 s; throws on error.
      return describeAlarmsInAlarm();
    },
  };
}

const ACK_COLUMNS = 'id,env,fingerprint,action,reason,severity,actor_user_id,actor_email,vtid,created_at,expires_at';

/** VTID-04886: ops_attention_acks via the service role (migration 20261005100000). */
export function supabaseAckStore(): AttentionAckStore {
  return {
    async active(env, nowIso): Promise<AckRow[]> {
      return check(
        await sb()
          .from('ops_attention_acks')
          .select(ACK_COLUMNS)
          .eq('env', env)
          .gt('expires_at', nowIso)
          .order('created_at', { ascending: false })
          .limit(500),
        'ops_attention_acks',
      ) as AckRow[];
    },
    async insert(row): Promise<AckRow> {
      const { data, error } = await sb().from('ops_attention_acks').insert(row).select(ACK_COLUMNS).single();
      if (error || !data) throw new Error(`ops_attention_acks: ${error ? error.message : 'no row returned'}`);
      return data as AckRow;
    },
  };
}

/** ops_attention_state via the service role (migration 20261004130000). */
export function supabaseAttentionStateStore(): AttentionStateStore {
  return {
    async load(env: VitanaEnv, fingerprints: string[]): Promise<StateRow[]> {
      if (!fingerprints.length) return [];
      return check(
        await sb()
          .from('ops_attention_state')
          .select('fingerprint,first_seen,last_seen')
          .eq('env', env)
          .in('fingerprint', fingerprints),
        'ops_attention_state',
      ) as StateRow[];
    },
    async save(env: VitanaEnv, rows: StateRow[]): Promise<void> {
      if (!rows.length) return;
      const { error } = await sb()
        .from('ops_attention_state')
        .upsert(rows.map((r) => ({ env, ...r })), { onConflict: 'env,fingerprint' });
      if (error) throw new Error(`ops_attention_state: ${error.message}`);
    },
  };
}
