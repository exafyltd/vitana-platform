/**
 * VTID-02753 — Voice Tool Expansion P1a: structured Health logging.
 *
 * Backs the four `log_*` voice tools (log_water, log_sleep, log_exercise,
 * log_meditation) declared in orb-live.ts. Each tool maps to a (pillar,
 * feature_key, value, unit) tuple that POSTs to
 * /api/v1/integrations/manual/log — but we call the underlying Supabase
 * RPCs directly here to avoid an extra HTTP hop inside the gateway.
 *
 * Mirrors the validation in routes/integrations.ts. Returns a compact
 * summary the LLM can read aloud:
 *   - pillar / feature_key / value / unit / date
 *   - per-pillar subscores after the write
 *   - delta vs the previous Index total
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

type LogTool = 'log_water' | 'log_sleep' | 'log_exercise' | 'log_meditation';

type ToolToFeature = {
  pillar: 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';
  feature_key: string;
  unit: string;
  bounds: { min: number; max: number };
};

const TOOL_MAP: Record<LogTool, ToolToFeature> = {
  log_water: {
    pillar: 'hydration',
    feature_key: 'water_intake',
    unit: 'ml',
    bounds: { min: 50, max: 5000 },
  },
  log_sleep: {
    pillar: 'sleep',
    feature_key: 'wearable_sleep_duration',
    unit: 'min',
    bounds: { min: 60, max: 960 },
  },
  log_exercise: {
    pillar: 'exercise',
    feature_key: 'wearable_workout',
    unit: 'min',
    bounds: { min: 5, max: 600 },
  },
  log_meditation: {
    pillar: 'mental',
    feature_key: 'meditation_minutes',
    unit: 'min',
    bounds: { min: 1, max: 240 },
  },
};

export interface LogHealthSignalInput {
  user_id: string;
  tenant_id: string | null;
  tool: LogTool;
  date: string;
  amount_ml?: number;
  minutes?: number;
  activity_type?: string;
}

export interface LogHealthSignalOutput {
  ok: true;
  summary: {
    tool: LogTool;
    pillar: string;
    feature_key: string;
    value: number;
    unit: string;
    date: string;
    activity_type?: string;
    pillar_score_after: number | null;
    total_after: number | null;
    index_delta: number | null;
  };
}

export interface LogHealthSignalError {
  ok: false;
  error: string;
}

function adminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function pickValue(tool: LogTool, input: LogHealthSignalInput): number | null {
  if (tool === 'log_water') {
    return typeof input.amount_ml === 'number' ? input.amount_ml : null;
  }
  return typeof input.minutes === 'number' ? input.minutes : null;
}

export async function logHealthSignal(
  input: LogHealthSignalInput,
): Promise<LogHealthSignalOutput | LogHealthSignalError> {
  const map = TOOL_MAP[input.tool];
  if (!map) return { ok: false, error: `unknown tool: ${input.tool}` };

  const value = pickValue(input.tool, input);
  if (value === null || !Number.isFinite(value)) {
    return { ok: false, error: 'amount_ml or minutes is required' };
  }
  if (value < map.bounds.min || value > map.bounds.max) {
    return {
      ok: false,
      error: `value out of range: ${value} ${map.unit} (allowed ${map.bounds.min}–${map.bounds.max})`,
    };
  }

  const admin = adminClient();
  if (!admin) return { ok: false, error: 'supabase_not_configured' };

  // Resolve tenant via user_tenants fallback (mirrors integrations.ts).
  let tenantId = input.tenant_id;
  if (!tenantId) {
    const { data: tenantRow } = await admin
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', input.user_id)
      .limit(1)
      .maybeSingle();
    tenantId = (tenantRow?.tenant_id as string | undefined) ?? null;
  }
  const effectiveTenantId = tenantId ?? '00000000-0000-0000-0000-000000000000';

  // Snapshot current Index for delta computation.
  const { data: prevRow } = await admin
    .from('vitana_index_scores')
    .select('score_total')
    .eq('user_id', input.user_id)
    .eq('date', input.date)
    .maybeSingle();
  const prevTotal = (prevRow?.score_total as number | undefined) ?? null;

  // Optional metadata: activity_type rides along on the row's metadata.
  const metadata =
    input.tool === 'log_exercise' && input.activity_type
      ? { activity_type: input.activity_type, source: 'voice_tool' }
      : { source: 'voice_tool' };

  const { error: featErr } = await admin.from('health_features_daily').upsert(
    {
      tenant_id: effectiveTenantId,
      user_id: input.user_id,
      date: input.date,
      feature_key: map.feature_key,
      feature_value: value,
      feature_unit: map.unit,
      sample_count: 1,
      confidence: 0.85,
      metadata,
    },
    { onConflict: 'tenant_id,user_id,date,feature_key' },
  );
  if (featErr) {
    return { ok: false, error: `feature_write_failed: ${featErr.message}` };
  }

  // Mark manual-entry integration connected (mirrors integrations.ts).
  await admin.from('user_integrations').upsert(
    {
      user_id: input.user_id,
      integration_id: 'manual-entry',
      status: 'connected',
      connected_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      metadata: { source: 'voice_tool' },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,integration_id' },
  );

  // Recompute the Index so the badge + pillar score reflect the new signal.
  const { data: newRow } = await admin.rpc('health_compute_vitana_index_for_user', {
    p_user_id: input.user_id,
    p_date: input.date,
  });

  const newTotal = (newRow?.score_total as number | undefined) ?? null;
  const pillarColumn = `score_${map.pillar}` as const;
  const pillarScoreAfter = (newRow?.[pillarColumn] as number | undefined) ?? null;

  return {
    ok: true,
    summary: {
      tool: input.tool,
      pillar: map.pillar,
      feature_key: map.feature_key,
      value,
      unit: map.unit,
      date: input.date,
      activity_type: input.activity_type,
      pillar_score_after: pillarScoreAfter,
      total_after: newTotal,
      index_delta: newTotal !== null && prevTotal !== null ? newTotal - prevTotal : null,
    },
  };
}
