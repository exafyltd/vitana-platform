// VTID-03109 — runtime invariant checks for AssistantDecisionContext.
//
// Two modes:
//   - 'strict': throws (use in dev/test).
//   - 'log':    returns a result + emits console.warn (use in prod, where
//               a render-time throw would crash a live voice session).
//
// What this catches: unknown enum values, verbatim strings carrying
// newlines or control chars, unknown extra fields on slices, schema
// version drift, presence/handle pairing mismatches.

import { SUPPORTED_LANGUAGES } from './types';

const RECENCY_BUCKETS = [
  'reconnect', 'recent', 'same_day', 'today',
  'yesterday', 'week', 'long', 'first',
] as const;
const PRIOR_OUTCOMES = ['success', 'failure', 'unknown'] as const;
const USER_ROLES = ['community', 'admin', 'developer', 'pro', 'unknown'] as const;
const TIME_OF_DAY = ['early_morning', 'morning', 'afternoon', 'evening', 'late_evening'] as const;
const CONTINUITY_STATES = [
  'fresh', 'continuing_recent_topic', 'returning_after_gap', 'reconnect_silent',
] as const;
const CONFIDENCE_BANDS = ['low', 'medium', 'high'] as const;
const RESPONSE_STYLES = ['directive', 'collaborative', 'exploratory', 'unknown'] as const;
const PACES = ['fast', 'measured', 'slow', 'unknown'] as const;
const TONES = ['warm', 'professional', 'playful', 'unknown'] as const;
const DEPTHS = ['brief', 'standard', 'comprehensive', 'unknown'] as const;

const ROOT_KEYS = new Set([
  'schema_version', 'session', 'identity', 'surface', 'locale',
  'continuity', 'interaction_style',
]);

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export type ValidationMode = 'strict' | 'log';

export function validateDecisionContext(
  ctx: unknown,
  mode: ValidationMode = 'strict',
): ValidationResult {
  const errors: string[] = [];
  validateRoot(ctx, errors);
  const ok = errors.length === 0;
  if (!ok) {
    if (mode === 'strict') {
      throw new Error(
        `AssistantDecisionContext invariant violation: ${errors.join('; ')}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn('[decision-contract] invariant violation:', errors);
  }
  return { ok, errors };
}

function validateRoot(ctx: unknown, errors: string[]): void {
  if (!isObj(ctx)) {
    errors.push('context must be a plain object');
    return;
  }
  if (ctx.schema_version !== 1) {
    errors.push(`schema_version must be 1, got ${JSON.stringify(ctx.schema_version)}`);
  }
  for (const k of Object.keys(ctx)) {
    if (!ROOT_KEYS.has(k)) errors.push(`unknown root field "${k}"`);
  }
  if (ctx.session !== undefined) validateSession(ctx.session, errors);
  if (ctx.identity !== undefined) validateIdentity(ctx.identity, errors);
  if (ctx.surface !== undefined) validateSurface(ctx.surface, errors);
  if (ctx.locale !== undefined) validateLocale(ctx.locale, errors);
  if (ctx.continuity !== undefined) validateContinuity(ctx.continuity, errors);
  if (ctx.interaction_style !== undefined) {
    validateInteractionStyle(ctx.interaction_style, errors);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkAllowedKeys(
  slice: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  const set = new Set(allowed);
  for (const k of Object.keys(slice)) {
    if (!set.has(k)) errors.push(`${path}: unknown field "${k}"`);
  }
}

function checkEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): void {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    errors.push(
      `${path} must be one of [${allowed.join('|')}], got ${JSON.stringify(v)}`,
    );
  }
}

function checkBool(v: unknown, path: string, errors: string[]): void {
  if (typeof v !== 'boolean') errors.push(`${path} must be boolean, got ${typeof v}`);
}

// charCodeAt loop is used instead of a control-char regex literal so the
// source file stays free of literal control bytes.
function hasControlOrNewline(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // C0 control range covers \t \n \r and friends; 0x7f = DEL.
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function checkVerbatimOrNull(v: unknown, path: string, errors: string[]): void {
  if (v === null) return;
  if (typeof v !== 'string') {
    errors.push(`${path} must be string|null, got ${typeof v}`);
    return;
  }
  if (v.length === 0) {
    errors.push(`${path} must be non-empty when present`);
    return;
  }
  if (v.length > 200) {
    errors.push(`${path} exceeds 200-char verbatim cap (got ${v.length})`);
    return;
  }
  if (hasControlOrNewline(v)) {
    errors.push(`${path} contains control characters or newlines (verbatim strings must be single-line plain text)`);
  }
}

function validateSession(v: unknown, errors: string[]): void {
  const path = 'session';
  if (!isObj(v)) { errors.push(`${path} must be an object`); return; }
  checkAllowedKeys(
    v,
    ['recency_bucket', 'prior_session_outcome', 'is_silent_resume'],
    path, errors,
  );
  checkEnum(v.recency_bucket, RECENCY_BUCKETS, `${path}.recency_bucket`, errors);
  checkEnum(v.prior_session_outcome, PRIOR_OUTCOMES, `${path}.prior_session_outcome`, errors);
  checkBool(v.is_silent_resume, `${path}.is_silent_resume`, errors);
}

function validateIdentity(v: unknown, errors: string[]): void {
  const path = 'identity';
  if (!isObj(v)) { errors.push(`${path} must be an object`); return; }
  checkAllowedKeys(
    v,
    ['role', 'has_vitana_id', 'vitana_id_handle', 'has_user_name', 'user_first_name'],
    path, errors,
  );
  checkEnum(v.role, USER_ROLES, `${path}.role`, errors);
  checkBool(v.has_vitana_id, `${path}.has_vitana_id`, errors);
  checkVerbatimOrNull(v.vitana_id_handle, `${path}.vitana_id_handle`, errors);
  checkBool(v.has_user_name, `${path}.has_user_name`, errors);
  checkVerbatimOrNull(v.user_first_name, `${path}.user_first_name`, errors);
  if (v.has_vitana_id === true && v.vitana_id_handle === null) {
    errors.push(`${path}: has_vitana_id=true but vitana_id_handle is null`);
  }
  if (v.has_vitana_id === false && v.vitana_id_handle !== null) {
    errors.push(`${path}: has_vitana_id=false but vitana_id_handle is set`);
  }
  if (v.has_user_name === true && v.user_first_name === null) {
    errors.push(`${path}: has_user_name=true but user_first_name is null`);
  }
  if (v.has_user_name === false && v.user_first_name !== null) {
    errors.push(`${path}: has_user_name=false but user_first_name is set`);
  }
}

function validateSurface(v: unknown, errors: string[]): void {
  const path = 'surface';
  if (!isObj(v)) { errors.push(`${path} must be an object`); return; }
  checkAllowedKeys(
    v,
    [
      'has_current_screen', 'current_screen_title', 'current_screen_route',
      'recent_screen_count', 'recent_screen_titles',
    ],
    path, errors,
  );
  checkBool(v.has_current_screen, `${path}.has_current_screen`, errors);
  checkVerbatimOrNull(v.current_screen_title, `${path}.current_screen_title`, errors);
  checkVerbatimOrNull(v.current_screen_route, `${path}.current_screen_route`, errors);
  const count = v.recent_screen_count;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) || count < 0 || count > 50
  ) {
    errors.push(`${path}.recent_screen_count must be integer 0..50`);
  }
  if (!Array.isArray(v.recent_screen_titles)) {
    errors.push(`${path}.recent_screen_titles must be array`);
  } else {
    v.recent_screen_titles.forEach((t, i) =>
      checkVerbatimOrNull(t, `${path}.recent_screen_titles[${i}]`, errors),
    );
    if (
      typeof count === 'number' &&
      v.recent_screen_titles.length !== count
    ) {
      errors.push(
        `${path}: recent_screen_count (${count}) does not match titles array length (${v.recent_screen_titles.length})`,
      );
    }
  }
  if (
    v.has_current_screen === true &&
    (v.current_screen_title === null || v.current_screen_route === null)
  ) {
    errors.push(`${path}: has_current_screen=true requires title and route to be set`);
  }
  if (
    v.has_current_screen === false &&
    (v.current_screen_title !== null || v.current_screen_route !== null)
  ) {
    errors.push(`${path}: has_current_screen=false requires title and route to be null`);
  }
}

function validateLocale(v: unknown, errors: string[]): void {
  const path = 'locale';
  if (!isObj(v)) { errors.push(`${path} must be an object`); return; }
  checkAllowedKeys(v, ['language', 'time_of_day_bucket', 'is_weekend'], path, errors);
  checkEnum(v.language, SUPPORTED_LANGUAGES, `${path}.language`, errors);
  checkEnum(v.time_of_day_bucket, TIME_OF_DAY, `${path}.time_of_day_bucket`, errors);
  checkBool(v.is_weekend, `${path}.is_weekend`, errors);
}

function validateContinuity(v: unknown, errors: string[]): void {
  const path = 'continuity';
  if (!isObj(v)) { errors.push(`${path} must be an object`); return; }
  checkAllowedKeys(
    v,
    ['state', 'has_pending_question', 'has_pending_decision', 'confidence_band'],
    path, errors,
  );
  checkEnum(v.state, CONTINUITY_STATES, `${path}.state`, errors);
  checkBool(v.has_pending_question, `${path}.has_pending_question`, errors);
  checkBool(v.has_pending_decision, `${path}.has_pending_decision`, errors);
  checkEnum(v.confidence_band, CONFIDENCE_BANDS, `${path}.confidence_band`, errors);
}

function validateInteractionStyle(v: unknown, errors: string[]): void {
  const path = 'interaction_style';
  if (!isObj(v)) { errors.push(`${path} must be an object`); return; }
  checkAllowedKeys(
    v,
    ['response_style', 'pace', 'tone', 'depth', 'confidence_band'],
    path, errors,
  );
  checkEnum(v.response_style, RESPONSE_STYLES, `${path}.response_style`, errors);
  checkEnum(v.pace, PACES, `${path}.pace`, errors);
  checkEnum(v.tone, TONES, `${path}.tone`, errors);
  checkEnum(v.depth, DEPTHS, `${path}.depth`, errors);
  checkEnum(v.confidence_band, CONFIDENCE_BANDS, `${path}.confidence_band`, errors);
}
