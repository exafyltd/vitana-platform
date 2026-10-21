/**
 * VTID-03885 — Partner Health Test Integration: self-service consent routes.
 *
 * Mounted at /api/v1/partner-health/consent. Auth: user JWT (requireAuthWithTenant).
 * Kept for app builds that still call it ("let DoctorBox share my test data
 * with Vitana", Settings -> Connected Apps -> Partner Labs).
 *
 * VTID-05092: grant/revoke delegate to the health-consent service with
 * category `partner_results`, so they now
 *   - validate `partner_key` against partner_registry (active|sandbox) —
 *     an unknown partner is 400 UNKNOWN_RESOURCE (revoke never checks, a
 *     member can always withdraw);
 *   - write consent + audit row in one transaction (fn_set_health_consent);
 *   - record text_version 'legacy-03885' (no wording was shown on this path;
 *     owner decision 2026-10-12: these grants stay valid);
 *   - emit health.consent.granted / health.consent.revoked.
 * Only scope `result_ingestion` can be written (the partner_results
 * category); `order_tracking` is still readable through GET but has no
 * category and no caller, so a write for it is 400 UNSUPPORTED_SCOPE.
 * Before the VTID-05092 migration is applied a grant answers 503
 * CONSENT_STORE_PENDING and writes nothing, while a revoke still works
 * through the pre-migration write (GDPR Art. 7(3): withdrawal must always be
 * possible); GET is unchanged.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuthWithTenant } from '../middleware/auth-supabase-jwt';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { checkDataSharingConsent, type DataSharingScope } from '../services/partner-health/consent';
import {
  LEGACY_TEXT_VERSION,
  buildHealthConsentOasisEvent,
  recordConsentEmitOutcome,
  setHealthConsent,
} from '../services/consent/health-consent';

const router = Router();
const SOURCE = 'partner-health-consent';
const VALID_SCOPES: DataSharingScope[] = ['order_tracking', 'result_ingestion'];

function getIdentity(req: Request): { user_id: string; tenant_id: string } | null {
  const auth = req as AuthenticatedRequest;
  if (!auth.identity?.user_id || !auth.identity?.tenant_id) return null;
  return { user_id: auth.identity.user_id, tenant_id: auth.identity.tenant_id };
}

function parseScope(raw: unknown): DataSharingScope | null {
  return typeof raw === 'string' && VALID_SCOPES.includes(raw as DataSharingScope) ? (raw as DataSharingScope) : null;
}

function requestId(req: Request): string {
  const h = req.headers['x-request-id'];
  return typeof h === 'string' && h.trim() && h.length <= 128 ? h.trim() : randomUUID();
}

router.get('/', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const partnerKey = typeof req.query.partner_key === 'string' ? req.query.partner_key : null;
  const scope = parseScope(req.query.scope);
  if (!partnerKey || !scope) return res.status(400).json({ ok: false, error: 'partner_key and scope are required' });

  const granted = await checkDataSharingConsent(supabase, identity, 'partner_integration', partnerKey, scope);
  return res.json({ ok: true, granted });
});

router.post('/grant', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const partnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : null;
  const scope = parseScope(req.body?.scope);
  if (!partnerKey || !scope) return res.status(400).json({ ok: false, error: 'partner_key and scope are required' });
  if (scope !== 'result_ingestion') return res.status(400).json({ ok: false, error: 'UNSUPPORTED_SCOPE' });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const result = await setHealthConsent(supabase, {
    identity,
    category: 'partner_results',
    resource_id: partnerKey,
    action: 'grant',
    granted_via: 'settings_connected_apps',
    text_version: LEGACY_TEXT_VERSION,
    locale: null,
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
  return res.json({ ok: true });
});

router.post('/revoke', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const partnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : null;
  const scope = parseScope(req.body?.scope);
  if (!partnerKey || !scope) return res.status(400).json({ ok: false, error: 'partner_key and scope are required' });
  if (scope !== 'result_ingestion') return res.status(400).json({ ok: false, error: 'UNSUPPORTED_SCOPE' });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const result = await setHealthConsent(supabase, {
    identity,
    category: 'partner_results',
    resource_id: partnerKey,
    action: 'revoke',
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
  return res.json({ ok: true });
});

export default router;
