/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): Nova 2 Sonic environment
 * configuration, readiness, canary allowlists, and language support.
 *
 * Hard constraints (see the Nova voice-provider plan):
 *   - Model is FIXED to `amazon.nova-2-sonic-v1:0` and region to
 *     `eu-north-1` — the only Bedrock region in Vitana's footprint that
 *     serves Nova 2 Sonic in-region (no geo/global inference profile
 *     exists for it). Env overrides for either are validation-checked and
 *     anything else makes readiness false with a typed reason, never a
 *     silent redirect of paid traffic.
 *   - Disabled unless NOVA_SONIC_ENABLED === 'true'.
 *   - Credentials come from the AWS SDK default chain (ECS task role) —
 *     this module never reads or stores key material.
 *   - Invalid allowlist entries FAIL readiness (typed reason) instead of
 *     silently broadening or narrowing access.
 */

export const NOVA_SONIC_MODEL_ID = 'amazon.nova-2-sonic-v1:0' as const;
export const NOVA_SONIC_REGION = 'eu-north-1' as const;

/** Languages eligible for the first Nova canary. Everything else → Vertex. */
export const NOVA_SONIC_SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'es'] as const;
export type NovaSonicLanguage = (typeof NOVA_SONIC_SUPPORTED_LANGUAGES)[number];

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** 7m15s — rotate 45s before Bedrock's 8-minute bidirectional stream cap. */
const DEFAULT_ROTATION_AFTER_MS = 435_000;

export type NovaSonicConfigIssue =
  | 'nova_region_invalid'
  | 'nova_model_invalid'
  | 'nova_canary_user_ids_invalid'
  | 'nova_canary_tenant_ids_invalid'
  | 'nova_connect_timeout_invalid'
  | 'nova_rotation_after_invalid';

export interface NovaSonicConfig {
  enabled: boolean;
  region: typeof NOVA_SONIC_REGION;
  modelId: typeof NOVA_SONIC_MODEL_ID;
  canaryUserIds: ReadonlySet<string>;
  canaryTenantIds: ReadonlySet<string>;
  connectTimeoutMs: number;
  rotationAfterMs: number;
  /**
   * Typed configuration problems. Non-empty issues force `ready` false —
   * misconfiguration is never silently corrected into live traffic.
   */
  issues: ReadonlyArray<NovaSonicConfigIssue>;
  /** True only when enabled AND the configuration parsed cleanly. */
  ready: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse a comma-separated UUID allowlist: trim entries, lowercase, drop
 * empties. Returns null when any non-empty entry is not a UUID — the caller
 * records a typed issue instead of guessing what was meant.
 */
export function parseUuidAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw || raw.trim().length === 0) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (!UUID_RE.test(entry)) return null;
    out.add(entry);
  }
  return out;
}

/** Language gate for the Nova canary (case-insensitive, base-tag match). */
export function isNovaSonicLanguageSupported(lang: string | undefined | null): boolean {
  if (!lang) return false;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return (NOVA_SONIC_SUPPORTED_LANGUAGES as readonly string[]).includes(base);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Parse Nova configuration from an environment bag. Pure — never throws. */
export function getNovaSonicConfig(env: NodeJS.ProcessEnv): NovaSonicConfig {
  const issues: NovaSonicConfigIssue[] = [];

  const enabled = env.NOVA_SONIC_ENABLED === 'true';

  // Region/model are pinned — a mismatched override is a typed failure, not
  // a redirect (Never-rule: no silent provider/priority changes).
  if (env.NOVA_SONIC_REGION !== undefined && env.NOVA_SONIC_REGION !== NOVA_SONIC_REGION) {
    issues.push('nova_region_invalid');
  }
  if (env.NOVA_SONIC_MODEL_ID !== undefined && env.NOVA_SONIC_MODEL_ID !== NOVA_SONIC_MODEL_ID) {
    issues.push('nova_model_invalid');
  }

  const canaryUserIds = parseUuidAllowlist(env.NOVA_SONIC_CANARY_USER_IDS);
  if (canaryUserIds === null) issues.push('nova_canary_user_ids_invalid');
  const canaryTenantIds = parseUuidAllowlist(env.NOVA_SONIC_CANARY_TENANT_IDS);
  if (canaryTenantIds === null) issues.push('nova_canary_tenant_ids_invalid');

  const connectTimeoutMs = parsePositiveInt(
    env.NOVA_SONIC_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
  );
  if (connectTimeoutMs === null) issues.push('nova_connect_timeout_invalid');

  const rotationAfterMs = parsePositiveInt(
    env.NOVA_SONIC_ROTATION_AFTER_MS,
    DEFAULT_ROTATION_AFTER_MS,
  );
  if (rotationAfterMs === null) issues.push('nova_rotation_after_invalid');

  return {
    enabled,
    region: NOVA_SONIC_REGION,
    modelId: NOVA_SONIC_MODEL_ID,
    canaryUserIds: canaryUserIds ?? new Set(),
    canaryTenantIds: canaryTenantIds ?? new Set(),
    connectTimeoutMs: connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    rotationAfterMs: rotationAfterMs ?? DEFAULT_ROTATION_AFTER_MS,
    issues,
    ready: enabled && issues.length === 0,
  };
}

/**
 * Identity gate: a session is canary-allowlisted when its user OR tenant is
 * on a non-empty allowlist. Empty allowlists allow NOBODY (explicit-opt-in
 * canary — never "empty means everyone").
 */
export function isNovaSonicIdentityAllowed(
  config: Pick<NovaSonicConfig, 'canaryUserIds' | 'canaryTenantIds'>,
  identity: { userId?: string | null; tenantId?: string | null },
): boolean {
  const user = identity.userId?.trim().toLowerCase();
  const tenant = identity.tenantId?.trim().toLowerCase();
  if (user && config.canaryUserIds.has(user)) return true;
  if (tenant && config.canaryTenantIds.has(tenant)) return true;
  return false;
}
