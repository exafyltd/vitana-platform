/**
 * VTID-04754: per-tenant Jev control (docs/JEV-INTEGRATION-PLAN.md §10.4).
 *
 *   tenant_settings.feature_flags.jev = { enabled, planes[], monthly_budget_usd }
 *
 * Checked before every call; spend is persisted per tenant × plane × month in
 * jev_spend_counters (never in-process only — the gateway runs several tasks
 * and every deploy resets memory). The budget is one number per tenant per
 * month; since VTID-04857 it caps the budgeted planes only (member, patient,
 * partner_org — see JEV_BUDGETED_PLANES), never internal or system_autopilot.
 *
 * Fails closed: a flag or spend read that fails means no call is made and the
 * caller keeps its own path (outcome 'fallback', reason named).
 *
 * Reads are cached for 30 s per tenant so a 500-document batch costs two
 * reads, not a thousand; recorded spend updates the cache immediately from
 * the RPC's returned month total.
 */

import { getSupabase } from '../../lib/supabase';
import type { JevPlane } from './jev-access';
import { parseJevTenantFlag, JevTenantFlag } from './jev-policy';
import * as repo from './jev-repository';

export interface JevControl {
  /** null = the flag could not be read or is malformed (fail closed). */
  getTenantFlag(tenantId: string): Promise<JevTenantFlag | null>;
  /**
   * null = spend could not be read (fail closed when a budget applies).
   * `planes` limits the sum to those planes (VTID-04857); omitted = all planes.
   */
  getMonthSpend(tenantId: string, planes?: readonly JevPlane[]): Promise<number | null>;
  recordSpend(tenantId: string, plane: JevPlane, inputTokens: number, costUsd: number): Promise<void>;
}

export const JEV_CONTROL_CACHE_MS = 30_000;

export function currentMonthUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const spendKey = (tenantId: string, planes?: readonly JevPlane[]) => `${tenantId}|${planes ? [...planes].sort().join(',') : '*'}`;

interface Cached<T> {
  value: T;
  at: number;
  month?: string;
}

export function createSupabaseJevControl(now: () => number = Date.now): JevControl {
  const flags = new Map<string, Cached<JevTenantFlag>>();
  const spend = new Map<string, Cached<number>>();

  return {
    async getTenantFlag(tenantId) {
      const hit = flags.get(tenantId);
      if (hit && now() - hit.at < JEV_CONTROL_CACHE_MS) return hit.value;
      const sb = getSupabase();
      if (!sb) return null;
      try {
        const { data, error } = await repo.fetchTenantFeatureFlags(sb, tenantId);
        if (error) {
          console.warn(`[jev] tenant flag read failed tenant=${tenantId}: ${error.message}`);
          return null;
        }
        const raw = (data as { feature_flags?: Record<string, unknown> } | null)?.feature_flags?.jev;
        const flag = parseJevTenantFlag(raw);
        if (!flag) {
          console.warn(`[jev] tenant flag malformed tenant=${tenantId} — Jev refused for this tenant until fixed`);
          return null;
        }
        flags.set(tenantId, { value: flag, at: now() });
        return flag;
      } catch (err: any) {
        console.warn(`[jev] tenant flag read threw tenant=${tenantId}: ${err?.message || err}`);
        return null;
      }
    },

    async getMonthSpend(tenantId, planes) {
      const month = currentMonthUtc(new Date(now()));
      const key = spendKey(tenantId, planes);
      const hit = spend.get(key);
      if (hit && hit.month === month && now() - hit.at < JEV_CONTROL_CACHE_MS) return hit.value;
      const sb = getSupabase();
      if (!sb) return null;
      try {
        const { data, error } = await repo.fetchTenantMonthSpend(sb, tenantId, month, planes);
        if (error) {
          console.warn(`[jev] spend read failed tenant=${tenantId}: ${error.message}`);
          return null;
        }
        const total = ((data as Array<{ cost_usd: number | string }>) || []).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
        spend.set(key, { value: total, at: now(), month });
        return total;
      } catch (err: any) {
        console.warn(`[jev] spend read threw tenant=${tenantId}: ${err?.message || err}`);
        return null;
      }
    },

    async recordSpend(tenantId, plane, inputTokens, costUsd) {
      const month = currentMonthUtc(new Date(now()));
      // Every cached sum that includes this plane moves by the cost.
      for (const [key, hit] of spend) {
        const [t, planes] = key.split('|');
        if (t === tenantId && hit.month === month && (planes === '*' || planes.split(',').includes(plane))) hit.value += costUsd;
      }
      const sb = getSupabase();
      if (!sb) {
        console.error(`[jev] spend NOT persisted (no Supabase client) tenant=${tenantId} plane=${plane} cost=${costUsd}`);
        return;
      }
      try {
        const { data, error } = await repo.recordSpendRpc(sb, tenantId, plane, inputTokens, costUsd);
        if (error) {
          console.error(`[jev] spend NOT persisted tenant=${tenantId} plane=${plane} cost=${costUsd}: ${error.message}`);
          return;
        }
        // The RPC returns the all-plane month total.
        if (data !== null && data !== undefined) spend.set(spendKey(tenantId), { value: Number(data), at: now(), month });
      } catch (err: any) {
        console.error(`[jev] spend NOT persisted tenant=${tenantId} plane=${plane}: ${err?.message || err}`);
      }
    },
  };
}

let defaultControl: JevControl | null = null;

export function getDefaultJevControl(): JevControl {
  return (defaultControl ||= createSupabaseJevControl());
}

/** Test seam: replace (or with null, reset) the process-wide control. */
export function setDefaultJevControlForTest(control: JevControl | null): void {
  defaultControl = control;
}

/**
 * In-memory control for tests and local runs. `initialSpend` is per tenant;
 * a number counts as member-plane spend (the plane a budget caps), a
 * record gives the spend per plane.
 */
export function createMemoryJevControl(
  flags: Record<string, unknown> = {},
  initialSpend: Record<string, number | Partial<Record<JevPlane, number>>> = {},
) {
  const byPlane: Record<string, Partial<Record<JevPlane, number>>> = {};
  for (const [t, v] of Object.entries(initialSpend)) byPlane[t] = typeof v === 'number' ? { member: v } : { ...v };
  const records: Array<{ tenantId: string; plane: JevPlane; inputTokens: number; costUsd: number }> = [];
  const sum = (tenantId: string, planes?: readonly JevPlane[]) =>
    Object.entries(byPlane[tenantId] || {}).reduce((a, [p, c]) => (!planes || planes.includes(p as JevPlane) ? a + (c || 0) : a), 0);
  const control: JevControl = {
    async getTenantFlag(tenantId) {
      return parseJevTenantFlag(flags[tenantId]);
    },
    async getMonthSpend(tenantId, planes) {
      return sum(tenantId, planes);
    },
    async recordSpend(tenantId, plane, inputTokens, costUsd) {
      records.push({ tenantId, plane, inputTokens, costUsd });
      const t = (byPlane[tenantId] ||= {});
      t[plane] = (t[plane] ?? 0) + costUsd;
    },
  };
  return { control, records, byPlane, spent: (tenantId: string, planes?: readonly JevPlane[]) => sum(tenantId, planes) };
}
