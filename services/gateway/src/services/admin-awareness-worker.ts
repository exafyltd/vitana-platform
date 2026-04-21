/**
 * BOOTSTRAP-ADMIN-KPI-AA: Admin awareness worker.
 *
 * Computes ~20 KPIs per tenant every 5 minutes and writes them to:
 *   - tenant_kpi_current (upsert; real-time)
 *   - tenant_kpi_daily   (upsert on snapshot_date = today; historical)
 *
 * KPI families (Phase AA):
 *   - users        (7 KPIs)
 *   - community    (6 KPIs)
 *   - autopilot    (5 KPIs)
 *
 * Follow-up phases add: knowledge, navigator, moderation, marketplace,
 * assistant, system_health. The jsonb payload schema is extensible.
 *
 * The worker iterates every active tenant in public.tenants. Counts are
 * compiled in parallel per tenant. Soft-fail on any per-KPI error — a bad
 * query never kills the worker or the row; affected KPIs come back as null.
 *
 * Reuse: patterns mirror routes/admin-autopilot.ts:310+ and
 * routes/tenant-admin/overview.ts — same tables, same Supabase client.
 */
import { getSupabase } from '../lib/supabase';
import { runAllScannersForTenant } from './admin-scanners';
import { storeTenantHealthIndex } from './admin-health-index';

const LOG_PREFIX = '[admin-kpi]';
const WORKER_TICK_MS = 5 * 60 * 1000; // 5 minutes
const WORKER_VERSION = 'phase-BB-CC-GG.2026-04-22';

type KpiPayload = Record<string, unknown>;

let workerHandle: ReturnType<typeof setInterval> | null = null;

export function startAdminAwarenessWorker(): void {
  if (workerHandle) {
    console.log(`${LOG_PREFIX} worker already started`);
    return;
  }
  console.log(`${LOG_PREFIX} starting; cadence=${WORKER_TICK_MS / 1000}s version=${WORKER_VERSION}`);

  // First run slightly delayed so the gateway finishes booting first.
  setTimeout(() => {
    runTick().catch((err) => console.warn(`${LOG_PREFIX} first tick failed:`, err?.message));
  }, 15_000);

  workerHandle = setInterval(() => {
    runTick().catch((err) => console.warn(`${LOG_PREFIX} tick failed:`, err?.message));
  }, WORKER_TICK_MS);
}

export function stopAdminAwarenessWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
    console.log(`${LOG_PREFIX} worker stopped`);
  }
}

/**
 * Run one tick: list tenants, compute KPIs for each, upsert snapshots.
 * Sequential per tenant (tenants count is small; parallelism gains are
 * negligible vs DB connection pressure from 60+ sub-queries in flight).
 */
async function runTick(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const tenants = await listActiveTenants();
  if (tenants.length === 0) return;

  let ok = 0;
  let failed = 0;
  for (const tenantId of tenants) {
    try {
      await computeAndStoreForTenant(tenantId);
      ok++;
    } catch (err: any) {
      failed++;
      console.warn(`${LOG_PREFIX} tenant=${tenantId.substring(0, 8)}... failed: ${err?.message || err}`);
    }
  }
  console.log(`${LOG_PREFIX} tick done ok=${ok} failed=${failed}`);
}

async function listActiveTenants(): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.from('tenants').select('tenant_id, is_active');
  if (error) {
    console.warn(`${LOG_PREFIX} listActiveTenants failed: ${error.message}`);
    return [];
  }
  return (data ?? [])
    .filter((row: { is_active?: boolean | null }) => row.is_active !== false)
    .map((row: { tenant_id: string }) => row.tenant_id);
}

export async function computeAndStoreForTenant(tenantId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const start = Date.now();
  const kpi: KpiPayload = {};

  // ---- Users family ----
  try {
    const now = new Date();
    const d1 = new Date(now.getTime() - 1 * 86400_000).toISOString();
    const d7 = new Date(now.getTime() - 7 * 86400_000).toISOString();
    const d14 = new Date(now.getTime() - 14 * 86400_000).toISOString();
    const d48h = new Date(now.getTime() + 2 * 86400_000).toISOString();

    const [totalMembers, signups24h, signups7d, signupsPrior7d, invPending, invExpiring48h] = await Promise.all([
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', d1),
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', d7),
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', d14).lt('created_at', d7),
      supabase.from('tenant_invitations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).is('accepted_at', null).is('revoked_at', null),
      supabase.from('tenant_invitations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).is('accepted_at', null).is('revoked_at', null).lte('expires_at', d48h).gte('expires_at', now.toISOString()),
    ]);

    const s7 = signups7d.count ?? 0;
    const sPrior = signupsPrior7d.count ?? 0;
    const deltaPct = sPrior > 0 ? Math.round(((s7 - sPrior) / sPrior) * 100) : (s7 > 0 ? 100 : 0);

    kpi.users = {
      total_members: totalMembers.count ?? 0,
      new_signups_24h: signups24h.count ?? 0,
      new_signups_7d: s7,
      new_signups_7d_prior: sPrior,
      new_signups_7d_delta_pct: deltaPct,
      invitations_pending: invPending.count ?? 0,
      invitations_expiring_48h: invExpiring48h.count ?? 0,
    };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} users family failed for ${tenantId.substring(0, 8)}...: ${err?.message}`);
    kpi.users = { error: err?.message || 'unknown' };
  }

  // ---- Community family ----
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const in7d = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const in14d = new Date(now.getTime() + 14 * 86400_000).toISOString();
    const d7 = new Date(now.getTime() - 7 * 86400_000).toISOString();

    const [eventsThisWeek, eventsNextWeek, groupsTotal, liveRoomsActive, newMemberships7d] = await Promise.all([
      supabase.from('global_community_events').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('start_time', nowIso).lt('start_time', in7d),
      supabase.from('global_community_events').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('start_time', in7d).lt('start_time', in14d),
      supabase.from('global_community_groups').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      supabase.from('live_rooms').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('ends_at', nowIso),
      supabase.from('community_memberships').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', d7),
    ]);

    kpi.community = {
      events_this_week: eventsThisWeek.count ?? 0,
      events_next_week: eventsNextWeek.count ?? 0,
      groups_total: groupsTotal.count ?? 0,
      live_rooms_active: liveRoomsActive.count ?? 0,
      new_memberships_7d: newMemberships7d.count ?? 0,
    };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} community family failed for ${tenantId.substring(0, 8)}...: ${err?.message}`);
    kpi.community = { error: err?.message || 'unknown' };
  }

  // ---- Autopilot family ----
  try {
    const now = new Date();
    const d1 = new Date(now.getTime() - 86400_000).toISOString();
    const d7 = new Date(now.getTime() - 7 * 86400_000).toISOString();

    const [runs24h, runsCompleted7d, runsFailed7d, recsNew, recsActivated7d] = await Promise.all([
      supabase.from('tenant_autopilot_runs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('started_at', d1),
      supabase.from('tenant_autopilot_runs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('started_at', d7).eq('status', 'completed'),
      supabase.from('tenant_autopilot_runs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('started_at', d7).eq('status', 'failed'),
      supabase.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'new'),
      supabase.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'activated').gte('updated_at', d7),
    ]);

    const completed = runsCompleted7d.count ?? 0;
    const failed = runsFailed7d.count ?? 0;
    const total = completed + failed;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : null;

    kpi.autopilot = {
      runs_24h: runs24h.count ?? 0,
      runs_completed_7d: completed,
      runs_failed_7d: failed,
      runs_success_rate_pct: successRate,
      recommendations_new: recsNew.count ?? 0,
      recommendations_activated_7d: recsActivated7d.count ?? 0,
    };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} autopilot family failed for ${tenantId.substring(0, 8)}...: ${err?.message}`);
    kpi.autopilot = { error: err?.message || 'unknown' };
  }

  const computationDurationMs = Date.now() - start;

  // Upsert current snapshot
  const { error: currentErr } = await supabase
    .from('tenant_kpi_current')
    .upsert(
      {
        tenant_id: tenantId,
        generated_at: new Date().toISOString(),
        kpi,
        computation_duration_ms: computationDurationMs,
        source_version: WORKER_VERSION,
      },
      { onConflict: 'tenant_id' },
    );
  if (currentErr) {
    console.warn(`${LOG_PREFIX} upsert current failed ${tenantId.substring(0, 8)}...: ${currentErr.message}`);
    return;
  }

  // Upsert today's daily snapshot
  const todayDate = new Date().toISOString().slice(0, 10);
  const { error: dailyErr } = await supabase
    .from('tenant_kpi_daily')
    .upsert(
      {
        tenant_id: tenantId,
        snapshot_date: todayDate,
        kpi,
        computed_at: new Date().toISOString(),
        computation_duration_ms: computationDurationMs,
        source_version: WORKER_VERSION,
      },
      { onConflict: 'tenant_id,snapshot_date' },
    );
  if (dailyErr) {
    console.warn(`${LOG_PREFIX} upsert daily failed ${tenantId.substring(0, 8)}...: ${dailyErr.message}`);
  }

  // BOOTSTRAP-ADMIN-BB-CC: run domain scanners after KPI compute.
  // Scanners soft-fail inside the runner; never propagates to break this tick.
  try {
    const scan = await runAllScannersForTenant(tenantId);
    if (scan.scanners_run > 0 || scan.insights_written > 0 || scan.insights_resolved > 0) {
      console.log(
        `${LOG_PREFIX} scanners tenant=${tenantId.substring(0, 8)}... ` +
          `ran=${scan.scanners_run} failed=${scan.scanners_failed} ` +
          `written=${scan.insights_written} resolved=${scan.insights_resolved}`,
      );
    }
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} scanner runner failed ${tenantId.substring(0, 8)}...: ${err?.message}`);
  }

  // BOOTSTRAP-ADMIN-GG: compute + upsert tenant health index. Idempotent
  // upsert by (tenant_id, snapshot_date=today), so the 5-min tick refreshes
  // the score continuously but only a single row per day survives. Emits
  // regression OASIS event when score drops > 10 points vs previous snapshot.
  try {
    const health = await storeTenantHealthIndex(tenantId);
    if (health) {
      console.log(
        `${LOG_PREFIX} health-index tenant=${tenantId.substring(0, 8)}... ` +
          `score=${health.score} components=${JSON.stringify(health.components)}`,
      );
    }
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} health-index failed ${tenantId.substring(0, 8)}...: ${err?.message}`);
  }
}
