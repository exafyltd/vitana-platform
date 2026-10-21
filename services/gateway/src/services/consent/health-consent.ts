/**
 * VTID-05092 — Health Hub Phase 0 / D10 (WP1): per-category health consent.
 *
 * One service over the VTID-03885 consent primitive
 * (`data_sharing_consents` + `data_sharing_consent_events`), extended by
 * migration `20261012180000_vtid_05092_health_consent_categories.sql`:
 *
 *   - `hasHealthConsent()` — the fail-closed check every enforcement point
 *     calls. It reads ONLY the pre-migration columns
 *     (resource_type / resource_id / scope / revoked_at) and takes
 *     resource_type + scope from HEALTH_CONSENT_CATEGORY_MAP, a static mirror
 *     of the migration seed, so it answers the same before and after the
 *     migration. Any error answers false.
 *   - `setHealthConsent()` — the only write path. It calls
 *     `fn_set_health_consent()`, which writes the consent row and its audit
 *     event in ONE transaction. Without the migration a GRANT answers
 *     CONSENT_STORE_PENDING (503) and writes nothing; a REVOKE falls back to
 *     the pre-migration write (legacyRevokeHealthConsent) because withdrawal
 *     must always work (GDPR Art. 7(3)).
 *   - `listMemberConsents()` / `listMemberConsentHistory()` — the member's
 *     own catalogue, rows and audit trail (identity from the JWT only).
 *
 * OASIS: the routes emit `health.consent.granted` / `health.consent.revoked`
 * after the function has committed, with the payload built here (category,
 * resource id, text version, locale, granted_via — never health values). An
 * emit failure is logged and counted, never undoes the consent: a revoke
 * must not be blocked by an OASIS outage, and the DB event row is the
 * authoritative audit.
 *
 * Connector ids (the `wearables` resource) are validated by the route, not
 * here: the connector registry imports partner-health ingestion, which
 * imports this module.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';

export const HEALTH_CONSENT_VTID = 'VTID-05092';

/** text_version recorded by the legacy /api/v1/partner-health/consent route (no wording was shown there). */
export const LEGACY_TEXT_VERSION = 'legacy-03885';

export type HealthConsentCategoryKey =
  | 'wearables'
  | 'partner_results'
  | 'ai_health_analysis'
  | 'health_data_analytics'
  | 'community_insights';

export type ConsentResourceType = 'health_category' | 'partner_integration' | 'health_source';

export interface CategoryMapping {
  resource_type: ConsentResourceType;
  scope: string;
  per_resource: boolean;
}

/**
 * Static mirror of the migration seed. `test/vtid-05092-health-consent.test.ts`
 * parses the SQL and fails if the two disagree.
 */
export const HEALTH_CONSENT_CATEGORY_MAP: Readonly<Record<HealthConsentCategoryKey, CategoryMapping>> = Object.freeze({
  wearables: { resource_type: 'health_source', scope: 'ingestion', per_resource: true },
  partner_results: { resource_type: 'partner_integration', scope: 'result_ingestion', per_resource: true },
  ai_health_analysis: { resource_type: 'health_category', scope: 'processing', per_resource: false },
  health_data_analytics: { resource_type: 'health_category', scope: 'processing', per_resource: false },
  community_insights: { resource_type: 'health_category', scope: 'processing', per_resource: false },
});

export const HEALTH_CONSENT_CATEGORY_KEYS = Object.keys(HEALTH_CONSENT_CATEGORY_MAP) as HealthConsentCategoryKey[];

export function isHealthConsentCategoryKey(value: unknown): value is HealthConsentCategoryKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HEALTH_CONSENT_CATEGORY_MAP, value);
}

/** The app's shipped locales (vitana-v1 src/i18n/<code>); the locale the wording was displayed in. */
export const CONSENT_LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'pl', 'pt', 'ru', 'sr', 'tr', 'zh'] as const;
export type ConsentLocale = (typeof CONSENT_LOCALES)[number];

export function isConsentLocale(value: unknown): value is ConsentLocale {
  return typeof value === 'string' && (CONSENT_LOCALES as readonly string[]).includes(value);
}

/** granted_via values a member's own request may carry. */
export const MEMBER_GRANTED_VIA = ['settings_privacy', 'settings_connected_apps', 'partner_link_confirm'] as const;
export type MemberGrantedVia = (typeof MEMBER_GRANTED_VIA)[number];
export type ConsentGrantedVia = MemberGrantedVia | 'checkout_flow' | 'portal_admin_backfill';

export function isMemberGrantedVia(value: unknown): value is MemberGrantedVia {
  return typeof value === 'string' && (MEMBER_GRANTED_VIA as readonly string[]).includes(value);
}

export interface ConsentIdentity {
  tenant_id: string;
  user_id: string;
}

interface DbError {
  code?: string;
  message?: string;
}

/** True when the error means the VTID-05092 migration is not applied (missing table, column or function). */
export function isConsentStoreMissing(err: DbError | null | undefined): boolean {
  if (!err) return false;
  if (err.code && ['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(err.code)) return true;
  const msg = String(err.message ?? '');
  return /relation .* does not exist|column .* does not exist|could not find the .* (table|column|function)|schema cache|function .* does not exist/i.test(
    msg,
  );
}

/**
 * The resource_id a consent is stored under: the partner_key / connector id
 * for a per-resource category, otherwise the category key itself. Null when a
 * per-resource category has no resource.
 */
export function resolveConsentResourceId(category: HealthConsentCategoryKey, resourceId?: string | null): string | null {
  const mapping = HEALTH_CONSENT_CATEGORY_MAP[category];
  if (!mapping.per_resource) return category;
  const trimmed = typeof resourceId === 'string' ? resourceId.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Maps a stored row back to its category (rows written before VTID-05092 have no category_key). */
export function categoryForRow(row: { resource_type: string; resource_id: string; scope: string }): HealthConsentCategoryKey | null {
  for (const key of HEALTH_CONSENT_CATEGORY_KEYS) {
    const m = HEALTH_CONSENT_CATEGORY_MAP[key];
    if (m.resource_type !== row.resource_type || m.scope !== row.scope) continue;
    if (m.per_resource || row.resource_id === key) return key;
  }
  return null;
}

/**
 * Active-row check on the pre-migration columns. Fail closed: an error or an
 * exception is never treated as consent.
 */
export async function checkActiveConsentRow(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  resourceType: string,
  resourceId: string,
  scope: string,
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from('data_sharing_consents')
      .select('id')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId)
      .eq('scope', scope)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) {
      console.error(`[${HEALTH_CONSENT_VTID}] consent check failed (treated as not granted): ${error.message}`);
      return false;
    }
    return !!data;
  } catch (err) {
    console.error(`[${HEALTH_CONSENT_VTID}] consent check threw (treated as not granted): ${String(err)}`);
    return false;
  }
}

/** True only if the member holds an active consent for this category (and resource, when per-resource). */
export async function hasHealthConsent(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  category: HealthConsentCategoryKey,
  resourceId?: string | null,
): Promise<boolean> {
  if (!isHealthConsentCategoryKey(category)) return false;
  const resource = resolveConsentResourceId(category, resourceId);
  if (!resource) return false;
  const mapping = HEALTH_CONSENT_CATEGORY_MAP[category];
  return checkActiveConsentRow(sb, identity, mapping.resource_type, resource, mapping.scope);
}

/**
 * VTID-05159 (Health Hub Phase 1 / A2, shared interface S7): the same check as
 * hasHealthConsent(), returning the active consent row's id (the health store
 * keeps it as `consent_id`, provenance only) or null. Fail closed: an unknown
 * category, a missing per-resource id, an error or an exception is null.
 */
export async function findActiveHealthConsentId(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  category: HealthConsentCategoryKey,
  resourceId?: string | null,
): Promise<string | null> {
  if (!isHealthConsentCategoryKey(category)) return null;
  const resource = resolveConsentResourceId(category, resourceId);
  if (!resource) return null;
  const mapping = HEALTH_CONSENT_CATEGORY_MAP[category];
  try {
    const { data, error } = await sb
      .from('data_sharing_consents')
      .select('id')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .eq('resource_type', mapping.resource_type)
      .eq('resource_id', resource)
      .eq('scope', mapping.scope)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) {
      console.error(`[${HEALTH_CONSENT_VTID}] consent id lookup failed (treated as not granted): ${error.message}`);
      return null;
    }
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch (err) {
    console.error(`[${HEALTH_CONSENT_VTID}] consent id lookup threw (treated as not granted): ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type HealthConsentErrorCode =
  | 'UNKNOWN_CATEGORY'
  | 'UNKNOWN_RESOURCE'
  | 'STALE_TEXT_VERSION'
  | 'CONSENT_STORE_PENDING'
  | 'INVALID_REQUEST'
  | 'CONSENT_WRITE_FAILED';

export interface SetHealthConsentInput {
  identity: ConsentIdentity;
  category: HealthConsentCategoryKey;
  resource_id?: string | null;
  action: 'grant' | 'revoke';
  granted_via?: ConsentGrantedVia | null;
  text_version?: string | null;
  locale?: string | null;
  actor?: { role: string; id: string | null };
  request_id?: string | null;
}

export interface HealthConsentChange {
  changed: boolean;
  action: 'grant' | 'revoke';
  category: HealthConsentCategoryKey;
  resource_type: string;
  resource_id: string;
  scope: string;
  text_version: string | null;
  shown_locale: string | null;
  granted_via: string | null;
  granted_at: string | null;
  revoked_at: string | null;
  consent_id: string | null;
  event_id: string | null;
}

export type SetHealthConsentResult =
  | ({ ok: true } & HealthConsentChange)
  | { ok: false; status: 400 | 409 | 500 | 503; error: HealthConsentErrorCode };

const FUNCTION_CODES: Record<string, { status: 400 | 409; error: HealthConsentErrorCode }> = {
  unknown_category: { status: 400, error: 'UNKNOWN_CATEGORY' },
  resource_required: { status: 400, error: 'UNKNOWN_RESOURCE' },
  unknown_resource: { status: 400, error: 'UNKNOWN_RESOURCE' },
  stale_text_version: { status: 409, error: 'STALE_TEXT_VERSION' },
  invalid_granted_via: { status: 400, error: 'INVALID_REQUEST' },
  invalid_action: { status: 400, error: 'INVALID_REQUEST' },
};

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Grant or revoke one consent through fn_set_health_consent (consent row +
 * audit event in one transaction). Never writes the tables directly. Error
 * answers carry a code, never a database message.
 */
export async function setHealthConsent(sb: SupabaseClient, input: SetHealthConsentInput): Promise<SetHealthConsentResult> {
  const { identity, category, action } = input;
  if (!isHealthConsentCategoryKey(category)) return { ok: false, status: 400, error: 'UNKNOWN_CATEGORY' };
  const actor = input.actor ?? { role: 'user', id: identity.user_id };

  try {
    const { data, error } = await sb.rpc('fn_set_health_consent', {
      p_tenant: identity.tenant_id,
      p_user: identity.user_id,
      p_category: category,
      p_resource_id: input.resource_id ?? null,
      p_action: action,
      p_granted_via: action === 'grant' ? input.granted_via ?? null : null,
      p_text_version: action === 'grant' ? input.text_version ?? null : null,
      p_locale: input.locale ?? null,
      p_actor_role: actor.role,
      p_actor_id: actor.id,
      p_request_id: input.request_id ?? null,
    });

    if (error) {
      if (isConsentStoreMissing(error)) {
        // GDPR Art. 7(3): withdrawal must always work, even when this code was
        // promoted before the migration. A revoke falls back to the pre-WP1
        // write; a grant stays fail-closed.
        if (action === 'revoke') {
          console.warn(`[${HEALTH_CONSENT_VTID}] fn_set_health_consent missing — revoking ${category} through the pre-migration fallback.`);
          return legacyRevokeHealthConsent(sb, input);
        }
        console.warn(`[${HEALTH_CONSENT_VTID}] fn_set_health_consent missing — migration not applied; grant refused, nothing written.`);
        return { ok: false, status: 503, error: 'CONSENT_STORE_PENDING' };
      }
      // Rolled back by Postgres: neither the consent nor its event was written.
      console.error(`[${HEALTH_CONSENT_VTID}] fn_set_health_consent ${action} ${category} failed: ${error.message}`);
      return { ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' };
    }

    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok !== true) {
      const mapped = FUNCTION_CODES[String(r.code)];
      if (mapped) return { ok: false, ...mapped };
      console.error(`[${HEALTH_CONSENT_VTID}] fn_set_health_consent answered an unknown code: ${String(r.code)}`);
      return { ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' };
    }

    return {
      ok: true,
      changed: r.changed === true,
      action,
      category,
      resource_type: str(r.resource_type) ?? HEALTH_CONSENT_CATEGORY_MAP[category].resource_type,
      resource_id: str(r.resource_id) ?? resolveConsentResourceId(category, input.resource_id) ?? '',
      scope: str(r.scope) ?? HEALTH_CONSENT_CATEGORY_MAP[category].scope,
      text_version: str(r.text_version),
      shown_locale: str(r.shown_locale),
      granted_via: str(r.granted_via),
      granted_at: str(r.granted_at),
      revoked_at: str(r.revoked_at),
      consent_id: str(r.consent_id),
      event_id: str(r.event_id),
    };
  } catch (err) {
    console.error(`[${HEALTH_CONSENT_VTID}] fn_set_health_consent ${action} ${category} threw: ${String(err)}`);
    return { ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' };
  }
}

let consentAuditFailures = 0;

/** Revokes committed without their audit row (pre-migration fallback only). */
export function getConsentAuditFailureCount(): number {
  return consentAuditFailures;
}

/**
 * Pre-migration revoke (VTID-05092 fallback, used ONLY when
 * fn_set_health_consent does not exist yet). Writes exactly what the
 * VTID-03885 code wrote, with pre-migration columns only:
 *   1. UPDATE data_sharing_consents SET revoked_at = now() on the member's
 *      active row(s) for resource_type / resource_id / scope;
 *   2. INSERT the data_sharing_consent_events audit row (legacy columns).
 * GDPR Art. 7(3) — withdrawing consent must always be possible and as easy as
 * giving it. The withdrawal therefore takes precedence over the audit row: if
 * step 2 fails the revoke still succeeds, and the failure is logged loudly and
 * counted (getConsentAuditFailureCount) so it can be reconciled. Not one
 * transaction — that is what the function adds once the migration is applied.
 */
export async function legacyRevokeHealthConsent(sb: SupabaseClient, input: SetHealthConsentInput): Promise<SetHealthConsentResult> {
  const { identity, category } = input;
  const mapping = HEALTH_CONSENT_CATEGORY_MAP[category];
  const resourceId = resolveConsentResourceId(category, input.resource_id);
  if (!resourceId) return { ok: false, status: 400, error: 'UNKNOWN_RESOURCE' };
  const actor = input.actor ?? { role: 'user', id: identity.user_id };
  const base = {
    changed: false,
    action: 'revoke' as const,
    category,
    resource_type: mapping.resource_type,
    resource_id: resourceId,
    scope: mapping.scope,
    text_version: null,
    shown_locale: null,
    granted_via: null,
    granted_at: null,
    revoked_at: null,
    consent_id: null,
    event_id: null,
  };

  try {
    const revokedAt = new Date().toISOString();
    const { data, error } = await sb
      .from('data_sharing_consents')
      .update({ revoked_at: revokedAt })
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .eq('resource_type', mapping.resource_type)
      .eq('resource_id', resourceId)
      .eq('scope', mapping.scope)
      .is('revoked_at', null)
      .select('id, tenant_id, user_id, resource_type, resource_id, scope, granted_at, revoked_at, granted_via, created_at');
    if (error) {
      console.error(`[${HEALTH_CONSENT_VTID}] pre-migration revoke of ${category} FAILED: ${error.message}`);
      return { ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' };
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: true, ...base }; // nothing active — idempotent, no event

    let eventId: string | null = null;
    for (const row of rows) {
      try {
        const ins = await sb
          .from('data_sharing_consent_events')
          .insert({
            tenant_id: identity.tenant_id,
            user_id: identity.user_id,
            resource_type: mapping.resource_type,
            resource_id: resourceId,
            scope: mapping.scope,
            action: 'revoke',
            actor_role: actor.role,
            actor_id: actor.id,
            before: { ...row, revoked_at: null },
            after: row,
          })
          .select('id')
          .maybeSingle();
        if (ins.error) throw new Error(ins.error.message);
        eventId = eventId ?? str((ins.data as { id?: unknown } | null)?.id);
      } catch (err) {
        consentAuditFailures += 1;
        console.error(
          `[${HEALTH_CONSENT_VTID}] AUDIT ROW MISSING: consent ${String(row.id)} (${category}/${resourceId}) was revoked but its data_sharing_consent_events row could not be written: ${String(err)} (audit failures so far: ${consentAuditFailures})`,
        );
      }
    }

    const first = rows[0];
    return {
      ok: true,
      ...base,
      changed: true,
      granted_via: str(first.granted_via),
      granted_at: str(first.granted_at),
      revoked_at: str(first.revoked_at) ?? revokedAt,
      consent_id: str(first.id),
      event_id: eventId,
    };
  } catch (err) {
    console.error(`[${HEALTH_CONSENT_VTID}] pre-migration revoke of ${category} threw: ${String(err)}`);
    return { ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' };
  }
}

// ---------------------------------------------------------------------------
// OASIS
// ---------------------------------------------------------------------------

/** The OASIS event for a committed change. Carries no health values. */
export function buildHealthConsentOasisEvent(
  change: HealthConsentChange,
  identity: ConsentIdentity,
  source: string,
): CicdOasisEvent {
  const granted = change.action === 'grant';
  return {
    vtid: HEALTH_CONSENT_VTID,
    type: granted ? 'health.consent.granted' : 'health.consent.revoked',
    source,
    status: 'success',
    message: `Member ${granted ? 'granted' : 'revoked'} health consent ${change.category}${
      HEALTH_CONSENT_CATEGORY_MAP[change.category].per_resource ? ` for ${change.resource_id}` : ''
    }.`,
    payload: {
      category: change.category,
      resource_id: change.resource_id,
      text_version: change.text_version,
      locale: change.shown_locale,
      granted_via: change.granted_via,
    },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
  };
}

let consentEmitFailures = 0;

/** Logs and counts a failed emit. Never throws: the consent is already committed. */
export function recordConsentEmitOutcome(outcome: unknown, change: HealthConsentChange): void {
  const ok = !!outcome && typeof outcome === 'object' && (outcome as { ok?: unknown }).ok === true;
  if (ok) return;
  consentEmitFailures += 1;
  console.error(
    `[${HEALTH_CONSENT_VTID}] health.consent.${change.action === 'grant' ? 'granted' : 'revoked'} emit failed for ${change.category} (consent ${change.consent_id ?? '?'} committed; failures so far: ${consentEmitFailures})`,
  );
}

export function getConsentEmitFailureCount(): number {
  return consentEmitFailures;
}

// ---------------------------------------------------------------------------
// Member reads
// ---------------------------------------------------------------------------

export interface ConsentCategoryView {
  key: string;
  resource_type: string;
  scope: string;
  per_resource: boolean;
  current_text_version: string;
  processing_active: boolean;
  sort: number;
}

export interface MemberConsentView {
  category: HealthConsentCategoryKey;
  resource_id: string;
  active: boolean;
  granted_at: string | null;
  revoked_at: string | null;
  granted_via: string | null;
  text_version: string | null;
  shown_locale: string | null;
}

export interface ConsentPartnerView {
  partner_key: string;
  display_name: string;
  status: string;
}

export interface ConsentConnectorView {
  id: string;
  display_name: string;
}

export type MemberConsentsResult =
  | {
      ok: true;
      store_pending: boolean;
      categories: ConsentCategoryView[];
      consents: MemberConsentView[];
      partners: ConsentPartnerView[];
      connectors: ConsentConnectorView[];
    }
  | { ok: false; status: 500; error: 'CONSENTS_UNAVAILABLE' };

const LEGACY_CONSENT_COLUMNS = 'resource_type, resource_id, scope, granted_at, revoked_at, granted_via';
const CONSENT_COLUMNS = `${LEGACY_CONSENT_COLUMNS}, category_key, text_version, shown_locale`;

interface ConsentRow {
  resource_type: string;
  resource_id: string;
  scope: string;
  granted_at: string | null;
  revoked_at: string | null;
  granted_via: string | null;
  category_key?: string | null;
  text_version?: string | null;
  shown_locale?: string | null;
}

export async function listMemberConsents(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  opts: { connectors: ConsentConnectorView[] },
): Promise<MemberConsentsResult> {
  const fail = (what: string, msg?: string): MemberConsentsResult => {
    console.error(`[${HEALTH_CONSENT_VTID}] listMemberConsents: ${what} failed${msg ? `: ${msg}` : ''}`);
    return { ok: false, status: 500, error: 'CONSENTS_UNAVAILABLE' };
  };

  try {
    let storePending = false;
    let categories: ConsentCategoryView[] = [];
    const cat = await sb
      .from('health_consent_categories')
      .select('key, resource_type, scope, per_resource, current_text_version, processing_active, sort')
      .eq('active', true)
      .order('sort', { ascending: true });
    if (cat.error) {
      if (!isConsentStoreMissing(cat.error)) return fail('catalogue read', cat.error.message);
      storePending = true;
    } else {
      categories = (cat.data ?? []) as ConsentCategoryView[];
    }

    const rows = await sb
      .from('data_sharing_consents')
      .select(storePending ? LEGACY_CONSENT_COLUMNS : CONSENT_COLUMNS)
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id);
    if (rows.error) return fail('consent read', rows.error.message);

    const consents: MemberConsentView[] = [];
    for (const row of (rows.data ?? []) as unknown as ConsentRow[]) {
      const category = isHealthConsentCategoryKey(row.category_key) ? row.category_key : categoryForRow(row);
      if (!category) continue; // not a health consent
      consents.push({
        category,
        resource_id: row.resource_id,
        active: row.revoked_at == null,
        granted_at: row.granted_at ?? null,
        revoked_at: row.revoked_at ?? null,
        granted_via: row.granted_via ?? null,
        text_version: row.text_version ?? null,
        shown_locale: row.shown_locale ?? null,
      });
    }

    const partners = await sb
      .from('partner_registry')
      .select('partner_key, display_name, status')
      .in('status', ['active', 'sandbox'])
      .order('display_name', { ascending: true });
    if (partners.error) return fail('partner read', partners.error.message);

    return {
      ok: true,
      store_pending: storePending,
      categories,
      consents,
      partners: (partners.data ?? []) as ConsentPartnerView[],
      connectors: opts.connectors,
    };
  } catch (err) {
    return fail('read', String(err));
  }
}

export interface ConsentHistoryEntry {
  id: string;
  action: 'grant' | 'revoke';
  category: HealthConsentCategoryKey;
  resource_id: string;
  text_version: string | null;
  shown_locale: string | null;
  actor_role: string | null;
  created_at: string;
}

export type ConsentHistoryResult =
  | { ok: true; store_pending: boolean; events: ConsentHistoryEntry[] }
  | { ok: false; status: 500; error: 'CONSENT_HISTORY_UNAVAILABLE' };

export const CONSENT_HISTORY_LIMIT = 100;

const LEGACY_EVENT_COLUMNS = 'id, action, resource_type, resource_id, scope, actor_role, created_at';
const EVENT_COLUMNS = `${LEGACY_EVENT_COLUMNS}, category_key, text_version, shown_locale`;

/** The member's own audit trail, newest first. Never before/after snapshots, actor ids or request ids. */
export async function listMemberConsentHistory(sb: SupabaseClient, identity: ConsentIdentity): Promise<ConsentHistoryResult> {
  const read = (columns: string) =>
    sb
      .from('data_sharing_consent_events')
      .select(columns)
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .order('created_at', { ascending: false })
      .limit(CONSENT_HISTORY_LIMIT);

  try {
    let storePending = false;
    let res = await read(EVENT_COLUMNS);
    if (res.error && isConsentStoreMissing(res.error)) {
      storePending = true;
      res = await read(LEGACY_EVENT_COLUMNS);
    }
    if (res.error) {
      console.error(`[${HEALTH_CONSENT_VTID}] listMemberConsentHistory failed: ${res.error.message}`);
      return { ok: false, status: 500, error: 'CONSENT_HISTORY_UNAVAILABLE' };
    }

    const events: ConsentHistoryEntry[] = [];
    for (const row of (res.data ?? []) as unknown as Array<ConsentRow & { id: string; action: string; actor_role: string | null; created_at: string }>) {
      const category = isHealthConsentCategoryKey(row.category_key) ? row.category_key : categoryForRow(row);
      if (!category) continue;
      events.push({
        id: row.id,
        action: row.action === 'revoke' ? 'revoke' : 'grant',
        category,
        resource_id: row.resource_id,
        text_version: row.text_version ?? null,
        shown_locale: row.shown_locale ?? null,
        actor_role: row.actor_role ?? null,
        created_at: row.created_at,
      });
    }
    return { ok: true, store_pending: storePending, events };
  } catch (err) {
    console.error(`[${HEALTH_CONSENT_VTID}] listMemberConsentHistory threw: ${String(err)}`);
    return { ok: false, status: 500, error: 'CONSENT_HISTORY_UNAVAILABLE' };
  }
}
