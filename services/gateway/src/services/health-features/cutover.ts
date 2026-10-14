/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the cutover switch (plan Change 13).
 *
 *   HEALTH_FEATURES_SOURCE        legacy (default; any unknown value = legacy)
 *                                 | derived_device | derived
 *   HEALTH_FEATURES_CUTOVER_DATE  C (YYYY-MM-DD): derived rows are published into
 *                                 health_features_daily for dates >= C only
 *
 * `legacy` is today's behaviour, byte for byte: nothing in this module touches a
 * writer, the bridge or W-sql. The switch is FORCED OFF on staging (staging
 * shares the production database) and needs a valid C — a derived value with no
 * or a malformed date is `legacy` (decision inside the plan: never publish with a
 * guessed start date).
 *
 * Both derived modes, for the writers they cover:
 *   - the writer no longer writes the cut-over keys to health_features_daily; it
 *     writes the same legacy-shaped row to health_features_daily_legacy_shadow
 *     (rollback, Change 14);
 *   - recordToHealthStore runs `cutover: true` — writeHealthSamples -> pending
 *     marker -> deriveAndStore(target 'live') synchronously, and any failure is
 *     returned to the caller (fatal for that call);
 *   - then the writer's existing Index recompute runs as before.
 *
 * `derived_device` (after Stage 1): the webhook writers and wearable_log_workout;
 *   device keys only; the D6a bridge is skipped (its rows go to the shadow).
 * `derived` (after Stage 2): every re-routed writer; every key with a store code;
 *   W-sql is skipped and /recompute/daily step 1 calls the derivation.
 *
 * A writer is cut over only when its own dual-write flag is on as well
 * (decision inside the plan: a derived mode never applies to a writer whose
 * store write is off — it would publish nothing and drop the legacy row).
 */

import { DERIVED_FEATURE_KEYS, DEVICE_FEATURE_KEYS, WRITER_SPEC, type HealthWriterId } from './feature-spec';
import { isDualWriteEnabledFor } from './flags';
import {
  featuresErrorCode,
  healthFeaturesRepository,
  type HealthFeaturesRepository,
  type LegacyFeatureRow,
} from './health-features-repository';
import type { SupabaseClient } from '@supabase/supabase-js';

export const HEALTH_FEATURES_SOURCES = ['legacy', 'derived_device', 'derived'] as const;
export type HealthFeaturesSource = (typeof HEALTH_FEATURES_SOURCES)[number];

export type CutoverOffReason = 'unset' | 'unknown_value' | 'staging' | 'cutover_date_missing';

export interface CutoverState {
  source: HealthFeaturesSource;
  /** C — set exactly when source !== 'legacy'. */
  cutover_date: string | null;
  /** Why the state is legacy (absent when a derived mode is active). */
  reason?: CutoverOffReason;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
    && new Date(Date.parse(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v;
}

export function getHealthFeaturesCutover(env: NodeJS.ProcessEnv = process.env): CutoverState {
  const raw = env.HEALTH_FEATURES_SOURCE;
  if (raw === undefined || raw === '' || raw === 'legacy') return { source: 'legacy', cutover_date: null, reason: 'unset' };
  if (raw !== 'derived_device' && raw !== 'derived') return { source: 'legacy', cutover_date: null, reason: 'unknown_value' };
  if (env.VITANA_ENV === 'staging') return { source: 'legacy', cutover_date: null, reason: 'staging' };
  const date = env.HEALTH_FEATURES_CUTOVER_DATE;
  if (!validDate(date)) return { source: 'legacy', cutover_date: null, reason: 'cutover_date_missing' };
  return { source: raw, cutover_date: date };
}

/** The feature keys a mode publishes from the store (and stops the covered writers writing). */
export function cutoverKeys(source: HealthFeaturesSource): readonly string[] {
  if (source === 'derived_device') return DEVICE_FEATURE_KEYS;
  if (source === 'derived') return DERIVED_FEATURE_KEYS;
  return [];
}

/** The writers a mode covers. */
export function cutoverWriters(source: HealthFeaturesSource): readonly HealthWriterId[] {
  if (source === 'legacy') return [];
  const all = Object.values(WRITER_SPEC);
  return (source === 'derived_device' ? all.filter((w) => w.flag === 'device') : all).map((w) => w.writer);
}

/** The writer runs in derived mode: covered by the mode AND its dual-write flag is on. */
export function isWriterCutOver(writer: HealthWriterId, env: NodeJS.ProcessEnv = process.env): boolean {
  const state = getHealthFeaturesCutover(env);
  if (state.source === 'legacy') return false;
  const spec = WRITER_SPEC[writer];
  if (!spec || !cutoverWriters(state.source).includes(writer)) return false;
  return isDualWriteEnabledFor(spec.flag, env);
}

/** One legacy (feature_key, date) write of `writer` goes to the shadow instead of health_features_daily. */
export function isFeatureWriteCutOver(writer: HealthWriterId, featureKey: string, date: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isWriterCutOver(writer, env)) return false;
  const state = getHealthFeaturesCutover(env);
  if (!state.cutover_date || !validDate(date) || date < state.cutover_date) return false;
  return cutoverKeys(state.source).includes(featureKey);
}

/**
 * The D6a bridge does not write health_features_daily once the webhook writer
 * is cut over (either derived mode, device dual-write on): the derivation takes
 * its place, and the bridge's rows go to the legacy shadow.
 */
export function isWearableBridgeCutOver(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWriterCutOver('webhook_daily', env);
}

/**
 * W-sql (health_compute_features_daily) is skipped in `derived` — with both
 * dual-write flags on, so every writer whose data W-sql could stand in for
 * really writes the store; /recompute/daily step 1 derives instead.
 */
export function isFeatureSqlCutOver(env: NodeJS.ProcessEnv = process.env): boolean {
  return getHealthFeaturesCutover(env).source === 'derived' && isDualWriteEnabledFor('device', env) && isDualWriteEnabledFor('self_logged', env);
}

/** Where a derivation publishes: 'live' (v2 + health_features_daily) once a derived mode is on, else 'v2'. */
export function derivationTargetFor(env: NodeJS.ProcessEnv = process.env): 'v2' | 'live' {
  return getHealthFeaturesCutover(env).source === 'legacy' ? 'v2' : 'live';
}

export type PersistFeatureResult = { error: { message: string } | null; cutover: boolean };

/**
 * A writer's legacy health_features_daily write, through the switch: when the
 * (writer, key, date) is cut over the same legacy-shaped row goes to
 * health_features_daily_legacy_shadow instead; otherwise `legacyWrite` runs
 * unchanged and its own result is returned as is (in `legacy` mode nothing else
 * is touched). The shadow branch never throws.
 */
export async function persistFeatureRow(
  sb: SupabaseClient,
  writer: HealthWriterId,
  row: LegacyFeatureRow,
  legacyWrite: () => PromiseLike<{ error: { message: string } | null } | { error: unknown }>,
  opts: { env?: NodeJS.ProcessEnv; repo?: HealthFeaturesRepository } = {},
): Promise<PersistFeatureResult> {
  const env = opts.env ?? process.env;
  if (!isFeatureWriteCutOver(writer, row.feature_key, row.date, env)) {
    // legacy: the writer's own call, its own result, untouched.
    const res = (await legacyWrite()) as { error: { message: string } | null };
    return { error: res?.error ?? null, cutover: false };
  }
  try {
    const repo = opts.repo ?? healthFeaturesRepository(sb);
    const res = await repo.upsertLegacyShadow([row]);
    return { error: res.error ? { message: `legacy_shadow_write_failed: ${featuresErrorCode(res.error)}` } : null, cutover: true };
  } catch {
    return { error: { message: 'legacy_shadow_write_failed: FEATURES_STORE_UNAVAILABLE' }, cutover: true };
  }
}

/**
 * A writer's read-modify-write of its own legacy value (log_meal's running
 * count): from the legacy shadow when the (writer, key, date) is cut over —
 * so the shadow keeps exactly what the legacy path would have held — else the
 * writer's own read, untouched.
 */
export async function readFeatureValueForWrite(
  sb: SupabaseClient,
  writer: HealthWriterId,
  key: { tenant_id: string; user_id: string; date: string; feature_key: string },
  legacyRead: () => PromiseLike<{ data: unknown; error: unknown }>,
  opts: { env?: NodeJS.ProcessEnv; repo?: HealthFeaturesRepository } = {},
): Promise<{ data: unknown; error: unknown }> {
  const env = opts.env ?? process.env;
  if (!isFeatureWriteCutOver(writer, key.feature_key, key.date, env)) return legacyRead();
  const repo = opts.repo ?? healthFeaturesRepository(sb);
  const res = await repo.fetchLegacyShadowValue(key.tenant_id, key.user_id, key.date, key.feature_key);
  return { data: res.data, error: res.error ? new Error(`legacy_shadow_read_failed: ${featuresErrorCode(res.error)}`) : null };
}

/** The D6a bridge's shadow writer for a cutover (wearable-features-bridge BridgeOptions.shadow). */
export function bridgeShadowWriter(sb: SupabaseClient, repo: HealthFeaturesRepository = healthFeaturesRepository(sb)) {
  return {
    insertIgnoringExisting: async (rows: Record<string, unknown>[]) =>
      ({ error: (await repo.insertLegacyShadowIgnoringExisting(rows as unknown as LegacyFeatureRow[])).error }),
    updateBridgeOwned: async (row: Record<string, unknown>) =>
      ({ error: (await repo.updateLegacyShadowBridgeOwned(row as unknown as LegacyFeatureRow)).error }),
  };
}
