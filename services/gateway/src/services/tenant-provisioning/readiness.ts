/**
 * VTID-05150: is a tenant ready to be opened? Pure — the route fetches the rows
 * (admin-tenants-repository.ts) and this decides. Used by
 * GET /api/v1/admin/tenants/:id/readiness and by the PATCH that sets
 * open_signup:true (refused unless every check is green, or an exafy_admin
 * override with a reason).
 *
 * No number is hardcoded: the notification baseline is the (type, source_key)
 * set every other active, non-platform tenant holds (the same rule
 * provision_tenant() uses), and the AI policies are compared with the default
 * tenant's providers. The response never carries an email address.
 */
import { SLUG_RE } from './schemas';
import { isReservedSlug } from './reserved-slugs';

export interface ReadinessCheck {
  key: string;
  ok: boolean;
  detail: string;
  informational?: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  legacy: boolean;
  schema_missing: boolean;
  checks: ReadinessCheck[];
}

export interface ControlKey { type: string; source_key: string }

export interface ReadinessInput {
  tenant: { tenant_id: string; slug: string | null; open_signup?: boolean | null };
  /** The tenant_settings row (null when none). */
  settings: Record<string, any> | null;
  /** Host for the path URL: domains.primary_domain, else FRONTEND_URL; null when neither is set. */
  platformHost: string | null;
  /** Object names under tenant-assets/<slug>/ (e.g. "logo.png"); null when the listing failed. */
  storageObjects: string[] | null;
  /** This tenant's notification controls. */
  controls: ControlKey[];
  /** The platform baseline (intersection over the other active, non-platform tenants). */
  baseline: ControlKey[];
  policyProviders: string[];
  defaultPolicyProviders: string[];
  autopilotRows: number;
  systemGroupWithBot: boolean;
  firstAdmin: boolean;
}

/** The (type, source_key) pairs every tenant in the map holds. */
export function computeNotificationBaseline(byTenant: Map<string, ControlKey[]>): ControlKey[] {
  const tenants = [...byTenant.values()].filter((rows) => rows.length > 0);
  if (tenants.length === 0) return [];
  const key = (c: ControlKey) => `${c.type}\u0000${c.source_key ?? ''}`;
  let common = new Set(tenants[0].map(key));
  for (const rows of tenants.slice(1)) {
    const mine = new Set(rows.map(key));
    common = new Set([...common].filter((k) => mine.has(k)));
  }
  return [...common].sort().map((k) => {
    const [type, source_key] = k.split('\u0000');
    return { type, source_key };
  });
}

/** `https://<host>` from a bare host or a URL; null when unusable. */
export function normalizeHost(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.origin;
  } catch {
    return null;
  }
}

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const REQUIRED_ASSETS = ['logo', 'favicon'] as const;
const ALL_ASSETS = ['logo', 'favicon', 'og_image'] as const;

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const s = input.settings ?? {};
  const schemaMissing = !input.settings || !('provisioned_at' in s);
  const legacy = !s.provisioned_at;
  const slug = input.tenant.slug ?? '';
  const checks: ReadinessCheck[] = [];
  const add = (key: string, ok: boolean, detail: string, informational = false) =>
    checks.push(informational ? { key, ok, detail, informational } : { key, ok, detail });

  const validFormat = slug.length >= 3 && slug.length <= 32 && SLUG_RE.test(slug);
  const reserved = isReservedSlug(slug);
  add(
    'slug_valid_not_reserved',
    validFormat && (!reserved || legacy),
    !validFormat ? 'slug format invalid' : reserved ? (legacy ? 'legacy slug (reserved for new tenants)' : 'slug is reserved') : 'ok',
  );

  const origin = input.platformHost ? normalizeHost(input.platformHost) : null;
  add('path_url', !!origin && validFormat, origin ? `${origin}/${slug}` : 'no platform host (domains.primary_domain / FRONTEND_URL)');

  const colors = s.brand?.colors ?? {};
  const colorsOk = HEX.test(colors.accent ?? '') && HEX.test(colors.bg ?? '') && HEX.test(colors.fg ?? '');
  add('brand_colors', colorsOk, colorsOk ? 'ok' : 'brand.colors {accent,bg,fg} missing or not #RRGGBB');

  const objects = input.storageObjects;
  const missing: string[] = [];
  for (const kind of ALL_ASSETS) {
    const p = s.brand?.[`${kind}_path`];
    const required = (REQUIRED_ASSETS as readonly string[]).includes(kind);
    if (!nonEmpty(p)) {
      if (required) missing.push(kind);
      continue;
    }
    const name = String(p).slice(slug.length + 1);
    if (!objects || !objects.includes(name)) missing.push(kind);
  }
  add(
    'assets_present',
    objects !== null && missing.length === 0,
    objects === null ? 'storage listing unavailable' : missing.length ? `missing: ${missing.join(', ')}` : 'ok',
  );

  add('legal_entity_line', nonEmpty(s.legal_entity_line), nonEmpty(s.legal_entity_line) ? 'ok' : 'missing');
  add('support_email', nonEmpty(s.support_email), nonEmpty(s.support_email) ? 'ok' : 'missing');
  const senderOk = nonEmpty(s.sender_name) && nonEmpty(s.sender_email);
  add('sender', senderOk, senderOk ? 'ok' : 'sender_name and sender_email required');

  const locales: unknown = s.enabled_locales;
  const ltcOk =
    Array.isArray(locales) && locales.length > 0 && locales.includes(s.default_locale) && nonEmpty(s.timezone) && /^[A-Z]{3}$/.test(s.currency ?? '');
  add('locales_timezone_currency', ltcOk, ltcOk ? `${s.default_locale} · ${s.timezone} · ${s.currency}` : 'incomplete');

  const cn = s.persona_facts?.community_name;
  add('persona_facts.community_name', nonEmpty(cn), nonEmpty(cn) ? 'ok' : 'missing');

  const have = new Set(input.controls.map((c) => `${c.type}\u0000${c.source_key ?? ''}`));
  const missingControls = input.baseline.filter((c) => !have.has(`${c.type}\u0000${c.source_key ?? ''}`));
  const providers = new Set(input.policyProviders);
  const missingPolicies = input.defaultPolicyProviders.filter((p) => !providers.has(p));
  const jev = s.feature_flags?.jev;
  const problems: string[] = [];
  if (input.baseline.length === 0) problems.push('no notification baseline');
  if (missingControls.length) problems.push(`${missingControls.length} baseline notification control(s) missing`);
  if (input.defaultPolicyProviders.length === 0) problems.push('default tenant has no AI policies');
  if (missingPolicies.length) problems.push(`AI policies missing: ${missingPolicies.join(', ')}`);
  if (input.autopilotRows < 1) problems.push('no autopilot settings row');
  if (!input.systemGroupWithBot) problems.push('no system group with the bot');
  if (!(jev && jev.enabled === true)) problems.push('jev flag not enabled');
  add(
    'instance_data',
    problems.length === 0,
    problems.length
      ? problems.join('; ')
      : `${input.controls.length} controls, ${input.policyProviders.length} policies, autopilot, system group, jev`,
  );

  add('first_admin', input.firstAdmin, input.firstAdmin ? 'ok' : 'no admin has accepted yet');
  add('open_signup', true, input.tenant.open_signup ? 'open' : 'invite-only', true);

  const ready = !schemaMissing && checks.every((c) => c.informational || c.ok);
  return { ready, legacy, schema_missing: schemaMissing, checks };
}
