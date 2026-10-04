/**
 * VTID-04876 — production data access for the /ops/attention adapters.
 *
 * Every read is in-process (plan REVISION 2 F3): the Phase 1a builders
 * (buildHealthSummary, buildPipelineSummary, buildVoiceOverview), the Dev
 * Autopilot supervisor snapshot, the system-controls service, the approvals
 * helpers, the ops-runtime build-info checks, and small bounded
 * service-role reads (supabase-js) with a LIMIT and an indexed filter
 * (topic + created_at, status, outcome). Nothing here makes an HTTP call to
 * this gateway's own routes.
 *
 * Every function throws on a failed read — the aggregator maps a throw to
 * an UNKNOWN source — and never turns "could not read" into "nothing found".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VitanaEnv } from '../env';
import { getSupabase } from '../lib/supabase';
import { buildHealthSummary } from './health-summary-builder';
import { buildPipelineSummary } from './pipeline-summary-builder';
import { buildVoiceOverview } from './voice-supervisor-overview';
import { buildSupervisorSnapshot } from './dev-autopilot-supervisor';
import { getAllSystemControls } from './system-controls-service';
import { isAutonomousExecutionTask } from '../routes/worker-orchestrator';
import { fetchApprovalEligibleVtids, fetchPrInfoForVtids } from '../routes/approvals';
import { runRuntimeCheckCached } from '../routes/ops-runtime-health';
import type { AttentionReads, ControlRow, LedgerRow, WaitingRow } from './ops-attention-adapters';
import type { AttentionStateStore, StateRow } from './ops-attention';

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
      return { verdict_summary: o.verdict_summary, verdicts: o.verdicts as any, window: o.window, generated_at: o.generated_at };
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
      const snap: any = await buildSupervisorSnapshot();
      if (!snap || snap.ok === false) throw new Error(`dev_autopilot_supervisor: ${snap?.error || 'unavailable'}`);
      return Array.isArray(snap.alerts) ? snap.alerts : [];
    },

    async selfHealOutcomes(sinceIso) {
      return check(
        await sb()
          .from('self_healing_log')
          .select('vtid,endpoint,failure_class,outcome,created_at')
          .in('outcome', ['escalated', 'rolled_back'])
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(100),
        'self_healing_log',
      ) as any[];
    },

    async pipelineBrokenVtids() {
      const r = await buildPipelineSummary();
      if (r.status !== 200) throw new Error(`pipeline_summary: ${(r.body as any).error || r.status}`);
      return r.body.attention_queue.filter((t: any) => t.severity === 'BROKEN').map((t: any) => String(t.vtid));
    },

    async inProgressLedger() {
      return check(
        await sb()
          .from('vtid_ledger')
          .select('vtid,title,metadata,claimed_by,claim_started_at,claim_expires_at,updated_at')
          .like('vtid', 'VTID-%')
          .eq('status', 'in_progress')
          .or('is_terminal.is.null,is_terminal.eq.false')
          .limit(500),
        'vtid_ledger',
      ) as LedgerRow[];
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
      if (process.env.VTID_ALLOCATOR_ENABLED === 'true') {
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
          .neq('status', 'RESOLVED')
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
