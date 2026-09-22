/**
 * VTID-04268: writable Dev Autopilot config fields.
 *
 * Only the safe, bounded numeric knobs on `dev_autopilot_config` are
 * writable from this surface. `allow_scope`/`deny_scope` (JSONB arrays
 * governing what the autonomous executor can touch) and `kill_switch`
 * (already handled by its own POST /config/kill-switch route, VTID-04264)
 * are deliberately excluded — too security-sensitive for a quick text-field
 * edit, per CLAUDE.md's governance posture on executor scope.
 */

export interface ConfigFieldBounds {
  min: number;
  max: number;
}

export const CONFIG_NUMERIC_FIELDS: Record<string, ConfigFieldBounds> = {
  daily_budget: { min: 0, max: 1000 },
  cooldown_minutes: { min: 0, max: 1440 },
  concurrency_cap: { min: 1, max: 50 },
  auto_archive_days: { min: 1, max: 365 },
  reject_suppression_days: { min: 0, max: 365 },
  eager_plan_top_k: { min: 1, max: 100 },
  select_all_cap: { min: 1, max: 500 },
  max_auto_fix_depth: { min: 0, max: 20 },
  post_deploy_verification_window_minutes: { min: 1, max: 1440 },
};

export type ConfigUpdateResult =
  | { ok: true; patch: Record<string, number> }
  | { ok: false; error: string };

/**
 * Pure validator: body -> either a patch of the accepted numeric fields,
 * or a named error. No I/O, no Supabase — the route layer applies the
 * patch once this returns ok:true.
 */
export function validateConfigUpdate(body: unknown): ConfigUpdateResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  if (keys.length === 0) {
    return { ok: false, error: 'no fields provided' };
  }

  const unknownKeys = keys.filter((k) => !(k in CONFIG_NUMERIC_FIELDS));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown or unwritable field(s): ${unknownKeys.join(', ')}` };
  }

  const patch: Record<string, number> = {};
  for (const key of keys) {
    const bounds = CONFIG_NUMERIC_FIELDS[key];
    const raw = input[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, error: `${key} must be a finite number` };
    }
    if (!Number.isInteger(raw)) {
      return { ok: false, error: `${key} must be an integer` };
    }
    if (raw < bounds.min || raw > bounds.max) {
      return { ok: false, error: `${key} must be between ${bounds.min} and ${bounds.max}` };
    }
    patch[key] = raw;
  }

  return { ok: true, patch };
}
