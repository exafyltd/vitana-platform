/**
 * VTID-05092 — Health Hub Phase 0 / D10 (WP1): the member's health consents.
 *
 * Mounted at /api/v1/health/consents. Auth: the member's own JWT
 * (requireAuthWithTenant). Identity comes ONLY from the JWT — a body or
 * query `user_id`/`tenant_id` is never read. There is no endpoint that lists
 * another member's consents.
 *
 *   GET  /          catalogue + the member's consents + active partners + wearable connectors
 *   POST /grant     { category, resource_id?, text_version, locale, granted_via? }
 *                   (VTID-05164: a sync_* grant names apple_health, health_connect
 *                   or an aggregator connector; granted_via may be native_health_sync)
 *   POST /revoke    { category, resource_id? }
 *   GET  /history   the member's own consent events, newest first, max 100
 *
 * Errors are codes, never database messages: INVALID_REQUEST,
 * UNKNOWN_CATEGORY, UNKNOWN_RESOURCE (400), STALE_TEXT_VERSION (409),
 * CONSENT_STORE_PENDING (503: a GRANT before the migration is applied —
 * nothing is written; a REVOKE never answers it, it falls back to the
 * pre-migration write because withdrawal must always work, GDPR Art. 7(3)),
 * CONSENT_WRITE_FAILED / CONSENTS_UNAVAILABLE /
 * CONSENT_HISTORY_UNAVAILABLE (500).
 *
 * Every committed change emits health.consent.granted / health.consent.revoked
 * AFTER the database has committed it; an emit failure is logged and counted
 * and never fails the request (the consent event row is the audit of record).
 */

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { requireAuthWithTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { listConnectors } from '../connectors';
import {
  LEGACY_TEXT_VERSION,
  buildHealthConsentOasisEvent,
  HEALTH_SYNC_SOURCE_KINDS,
  isConsentLocale,
  isHealthConsentCategoryKey,
  isHealthSyncConsentKey,
  isMemberGrantedVia,
  listMemberConsentHistory,
  listMemberConsents,
  recordConsentEmitOutcome,
  setHealthConsent,
  type ConsentConnectorView,
  type ConsentIdentity,
  type HealthConsentChange,
  type MemberGrantedVia,
} from '../services/consent/health-consent';

const router = Router();
const SOURCE = 'health-consent';

/** Connector categories that deliver device health data (the `wearables` consent's resources). */
const WEARABLE_CONNECTOR_CATEGORIES = new Set(['wearable', 'aggregator']);

export function wearableConnectors(): ConsentConnectorView[] {
  return listConnectors()
    .filter((c) => WEARABLE_CONNECTOR_CATEGORIES.has(String(c.category)))
    .map((c) => ({ id: c.id, display_name: c.display_name }));
}

/**
 * VTID-05164 (C1): resources a `sync_*` consent may name — the phone health
 * stores (HEALTH_SYNC_SOURCE_KINDS) and the aggregator connectors.
 */
export function healthSyncConsentResources(): string[] {
  const aggregators = listConnectors()
    .filter((c) => String(c.category) === 'aggregator')
    .map((c) => c.id);
  return [...HEALTH_SYNC_SOURCE_KINDS, ...aggregators];
}

function getIdentity(req: Request): ConsentIdentity | null {
  const auth = req as AuthenticatedRequest;
  if (!auth.identity?.user_id || !auth.identity?.tenant_id) return null;
  return { user_id: auth.identity.user_id, tenant_id: auth.identity.tenant_id };
}

function requestId(req: Request): string {
  const h = req.headers['x-request-id'];
  return typeof h === 'string' && h.trim() && h.length <= 128 ? h.trim() : randomUUID();
}

function optionalString(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : undefined;
}

function invalid(res: Response, field: string) {
  return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', field });
}

router.get('/', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const result = await listMemberConsents(supabase, identity, { connectors: wearableConnectors() });
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
  return res.json(result);
});

router.get('/history', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const result = await listMemberConsentHistory(supabase, identity);
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
  return res.json(result);
});

router.post('/grant', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.category !== 'string' || !body.category) return invalid(res, 'category');
  if (!isHealthConsentCategoryKey(body.category)) return res.status(400).json({ ok: false, error: 'UNKNOWN_CATEGORY' });
  const category = body.category;
  const resourceId = optionalString(body.resource_id);
  if (resourceId === undefined) return invalid(res, 'resource_id');
  if (typeof body.text_version !== 'string' || !body.text_version.trim()) return invalid(res, 'text_version');
  // The legacy label is reserved for the legacy partner route (no wording shown there).
  if (body.text_version === LEGACY_TEXT_VERSION) return res.status(409).json({ ok: false, error: 'STALE_TEXT_VERSION' });
  if (!isConsentLocale(body.locale)) return invalid(res, 'locale');
  let grantedVia: MemberGrantedVia = 'settings_privacy';
  if (body.granted_via !== undefined && body.granted_via !== null) {
    if (!isMemberGrantedVia(body.granted_via)) return invalid(res, 'granted_via');
    grantedVia = body.granted_via;
  }
  // The connector id is checked here; partner keys are checked against
  // partner_registry inside fn_set_health_consent.
  if (category === 'wearables' && !wearableConnectors().some((c) => c.id === resourceId)) {
    return res.status(400).json({ ok: false, error: 'UNKNOWN_RESOURCE' });
  }
  if (isHealthSyncConsentKey(category) && !healthSyncConsentResources().includes(String(resourceId ?? ''))) {
    return res.status(400).json({ ok: false, error: 'UNKNOWN_RESOURCE' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const result = await setHealthConsent(supabase, {
    identity,
    category,
    resource_id: resourceId,
    action: 'grant',
    granted_via: grantedVia,
    text_version: body.text_version,
    locale: body.locale,
    actor: { role: 'user', id: identity.user_id },
    request_id: requestId(req),
  });
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });

  if (result.changed) {
    const emitted = await emitOasisEvent(buildHealthConsentOasisEvent(result, identity, SOURCE)).catch((err: unknown) => ({
      ok: false,
      error: String(err),
    }));
    recordConsentEmitOutcome(emitted, result);
  }
  return res.json({ ok: true, changed: result.changed, consent: consentView(result) });
});

router.post('/revoke', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.category !== 'string' || !body.category) return invalid(res, 'category');
  if (!isHealthConsentCategoryKey(body.category)) return res.status(400).json({ ok: false, error: 'UNKNOWN_CATEGORY' });
  const resourceId = optionalString(body.resource_id);
  if (resourceId === undefined) return invalid(res, 'resource_id');
  // A revoke never checks that the partner/connector still exists: a member
  // can always withdraw.
  const locale = isConsentLocale(body.locale) ? body.locale : null;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const result = await setHealthConsent(supabase, {
    identity,
    category: body.category,
    resource_id: resourceId,
    action: 'revoke',
    locale,
    actor: { role: 'user', id: identity.user_id },
    request_id: requestId(req),
  });
  if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });

  if (result.changed) {
    const emitted = await emitOasisEvent(buildHealthConsentOasisEvent(result, identity, SOURCE)).catch((err: unknown) => ({
      ok: false,
      error: String(err),
    }));
    recordConsentEmitOutcome(emitted, result);
  }
  return res.json({ ok: true, changed: result.changed, consent: consentView(result) });
});

/** The consent as the member sees it after the call. */
export function consentView(change: HealthConsentChange) {
  return {
    category: change.category,
    resource_id: change.resource_id,
    active: change.action === 'grant',
    text_version: change.text_version,
    shown_locale: change.shown_locale,
    granted_via: change.granted_via,
    granted_at: change.granted_at,
    revoked_at: change.revoked_at,
  };
}

export default router;
