/**
 * VTID-05163 (Health Hub Phase 1 / B3) — step 1 of POST /api/v1/health/recompute/daily
 * in the `derived` cutover mode (plan Change 13): instead of W-sql
 * (`health_compute_features_daily(date)`, F9), the caller's own member-day is
 * derived from the health store and published into health_features_daily
 * (deriveAndStore target 'live'). Answers in W-sql's result shape
 * ({ ok, upserted_count, tenant_id, user_id }) so the route's steps 2–3 and
 * its response stay as they are. Only called when isFeatureSqlCutOver() — in
 * `legacy` / `derived_device` the route runs W-sql exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';
import { defaultDerivationDeps, deriveAndStore, type DerivationDeps } from './derive-daily-features';

export interface RecomputeFeaturesStepResult {
  data: { ok: boolean; upserted_count?: number; tenant_id?: string; user_id?: string; source?: string; error?: string; message?: string };
  error: { message: string } | null;
}

export interface RecomputeFeaturesStepDeps {
  admin: () => SupabaseClient | null;
  derivation: (admin: SupabaseClient) => DerivationDeps;
}

const DEFAULT_DEPS: RecomputeFeaturesStepDeps = {
  admin: getSupabase,
  derivation: (admin) => defaultDerivationDeps(admin),
};

export async function deriveFeaturesForRecompute(
  userClient: SupabaseClient,
  date: string,
  deps: RecomputeFeaturesStepDeps = DEFAULT_DEPS,
): Promise<RecomputeFeaturesStepResult> {
  const fail = (code: string): RecomputeFeaturesStepResult => ({
    data: { ok: false, error: 'FEATURES_DERIVATION_FAILED', message: code },
    error: null,
  });
  try {
    const admin = deps.admin();
    if (!admin) return fail('DB_UNAVAILABLE');
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (userErr || !userId) return fail('UNAUTHENTICATED');
    const { data: tenantRow, error: tenantErr } = await admin
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', userId)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();
    const tenantId = (tenantRow as { tenant_id?: string } | null)?.tenant_id;
    if (tenantErr || !tenantId) return fail('NO_TENANT');
    const res = await deriveAndStore(deps.derivation(admin), { tenant_id: tenantId, user_id: userId }, [date], 'live');
    if (!res.ok) return fail(res.code);
    return { data: { ok: true, upserted_count: res.published ?? 0, tenant_id: tenantId, user_id: userId, source: 'derived_v2' }, error: null };
  } catch {
    return fail('THREW');
  }
}
