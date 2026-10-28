/**
 * VTID-04268: writable Dev Autopilot config fields.
 *
 * Only the safe, bounded numeric knobs on `dev_autopilot_config` are
 * writable from this surface. `allow_scope`/`deny_scope` (JSONB arrays
 * governing what the autonomous executor can touch) and `kill_switch`
 * (already handled by its own POST /config/kill-switch route, VTID-04264)
 * are deliberately excluded — too security-sensitive for a quick text-field
 * edit, per CLAUDE.md's governance posture on executor scope.
 *
 * VTID-05146 (C2): `frozen_scope` IS writable here. It can only take work away
 * from the executor (a plan touching it is never approved, a PR touching it is
 * never merged) — it can never widen what the executor may touch, which is
 * why allow_scope/deny_scope stay excluded and this one does not.
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
  overlap_hold_max_hours: { min: 1, max: 720 },
};

/** VTID-05146: frozen_scope — at most this many globs, each this long. */
export const FROZEN_SCOPE_MAX_GLOBS = 50;
export const FROZEN_SCOPE_MAX_GLOB_LENGTH = 200;

function validateFrozenScope(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'frozen_scope must be an array of glob strings' };
  if (raw.length > FROZEN_SCOPE_MAX_GLOBS) return { ok: false, error: `frozen_scope has more than ${FROZEN_SCOPE_MAX_GLOBS} entries` };
  const out: string[] = [];
  for (const g of raw) {
    if (typeof g !== 'string' || g.trim().length === 0) return { ok: false, error: 'frozen_scope entries must be non-empty strings' };
    const t = g.trim();
    if (t.length > FROZEN_SCOPE_MAX_GLOB_LENGTH) return { ok: false, error: `frozen_scope entry longer than ${FROZEN_SCOPE_MAX_GLOB_LENGTH} characters` };
    if (t.startsWith('/') || t.includes('..')) return { ok: false, error: `frozen_scope entry "${t}" must be a repo-relative glob` };
    out.push(t);
  }
  return { ok: true, value: Array.from(new Set(out)) };
}

export type ConfigUpdateResult =
  | { ok: true; patch: Record<string, number | string[]> }
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

  const unknownKeys = keys.filter((k) => !(k in CONFIG_NUMERIC_FIELDS) && k !== 'frozen_scope');
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown or unwritable field(s): ${unknownKeys.join(', ')}` };
  }

  const patch: Record<string, number | string[]> = {};
  for (const key of keys) {
    if (key === 'frozen_scope') {
      const fs = validateFrozenScope(input[key]);
      if (!fs.ok) return { ok: false, error: fs.error };
      patch[key] = fs.value;
      continue;
    }
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
