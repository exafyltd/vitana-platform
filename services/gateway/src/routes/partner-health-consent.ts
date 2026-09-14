/**
 * VTID-03885 — Partner Health Test Integration: self-service consent routes.
 *
 * Mounted at /api/v1/partner-health/consent. Auth: user JWT (requireAuthWithTenant)
 * — this is the ONE consent flow the spec asks to wire for real: "let
 * DoctorBox share my test data with Vitana", from Settings -> Connected
 * Apps' existing "Partner Labs" entry (today a comingSoon:true mock).
 *
 * Thin wrapper over services/partner-health/consent.ts — no business logic
 * lives here.
 */

import { Router, Request, Response } from 'express';
import { requireAuthWithTenant } from '../middleware/auth-supabase-jwt';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  checkDataSharingConsent,
  grantDataSharingConsent,
  revokeDataSharingConsent,
  type DataSharingScope,
} from '../services/partner-health/consent';

const router = Router();
const VALID_SCOPES: DataSharingScope[] = ['order_tracking', 'result_ingestion'];

function getIdentity(req: Request): { user_id: string; tenant_id: string } | null {
  const auth = req as AuthenticatedRequest;
  if (!auth.identity?.user_id || !auth.identity?.tenant_id) return null;
  return { user_id: auth.identity.user_id, tenant_id: auth.identity.tenant_id };
}

function parseScope(raw: unknown): DataSharingScope | null {
  return typeof raw === 'string' && VALID_SCOPES.includes(raw as DataSharingScope) ? (raw as DataSharingScope) : null;
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
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const partnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : null;
  const scope = parseScope(req.body?.scope);
  if (!partnerKey || !scope) return res.status(400).json({ ok: false, error: 'partner_key and scope are required' });

  const result = await grantDataSharingConsent(
    supabase,
    identity,
    'partner_integration',
    partnerKey,
    scope,
    'settings_connected_apps'
  );
  if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
  return res.json({ ok: true });
});

router.post('/revoke', requireAuthWithTenant, async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const partnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : null;
  const scope = parseScope(req.body?.scope);
  if (!partnerKey || !scope) return res.status(400).json({ ok: false, error: 'partner_key and scope are required' });

  const result = await revokeDataSharingConsent(supabase, identity, 'partner_integration', partnerKey, scope);
  if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
  return res.json({ ok: true });
});

export default router;
