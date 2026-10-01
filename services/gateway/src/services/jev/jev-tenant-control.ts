/**
 * VTID-04754: per-tenant Jev control (docs/JEV-INTEGRATION-PLAN.md §10.4).
 *
 *   tenant_settings.feature_flags.jev = { enabled, planes[], monthly_budget_usd }
 *
 * Checked before every call; spend is persisted per tenant × plane × month in
 * jev_spend_counters (never in-process only — the gateway runs several tasks
 * and every deploy resets memory). The budget is one number per tenant per
 * month across all planes.
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
  /** null = spend could not be read (fail closed when a budget applies). */
  getMonthSpend(tenantId: string): Promise<number | null>;
  recordSpend(tenantId: string, plane: JevPlane, inputTokens: number, costUsd: number): Promise<void>;
}

export const JEV_CONTROL_CACHE_MS = 30_000;

export function currentMonthUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

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

    async getMonthSpend(tenantId) {
      const month = currentMonthUtc(new Date(now()));
      const hit = spend.get(tenantId);
      if (hit && hit.month === month && now() - hit.at < JEV_CONTROL_CACHE_MS) return hit.value;
      const sb = getSupabase();
      if (!sb) return null;
      try {
        const { data, error } = await repo.fetchTenantMonthSpend(sb, tenantId, month);
        if (error) {
          console.warn(`[jev] spend read failed tenant=${tenantId}: ${error.message}`);
          return null;
        }
        const total = ((data as Array<{ cost_usd: number | string }>) || []).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
        spend.set(tenantId, { value: total, at: now(), month });
        return total;
      } catch (err: any) {
        console.warn(`[jev] spend read threw tenant=${tenantId}: ${err?.message || err}`);
        return null;
      }
    },

    async recordSpend(tenantId, plane, inputTokens, costUsd) {
      const month = currentMonthUtc(new Date(now()));
      const hit = spend.get(tenantId);
      if (hit && hit.month === month) hit.value += costUsd;
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
        if (data !== null && data !== undefined) spend.set(tenantId, { value: Number(data), at: now(), month });
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

/** In-memory control for tests and local runs. */
export function createMemoryJevControl(flags: Record<string, unknown> = {}, initialSpend: Record<string, number> = {}) {
  const spent: Record<string, number> = { ...initialSpend };
  const records: Array<{ tenantId: string; plane: JevPlane; inputTokens: number; costUsd: number }> = [];
  const control: JevControl = {
    async getTenantFlag(tenantId) {
      return parseJevTenantFlag(flags[tenantId]);
    },
    async getMonthSpend(tenantId) {
      return spent[tenantId] ?? 0;
    },
    async recordSpend(tenantId, plane, inputTokens, costUsd) {
      records.push({ tenantId, plane, inputTokens, costUsd });
      spent[tenantId] = (spent[tenantId] ?? 0) + costUsd;
    },
  };
  return { control, records, spent };
}
