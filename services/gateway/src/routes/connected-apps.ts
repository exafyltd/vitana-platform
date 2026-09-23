/**
 * VTID-04402: Connected Apps API — the nine mail / calendar / contacts apps,
 * one toggle each. See services/connected-apps/hub.ts.
 *
 *   GET  /api/v1/connected-apps                        state of every app
 *   POST /api/v1/connected-apps/:id/connect            turn on (may return auth_url)
 *   POST /api/v1/connected-apps/:id/disconnect         turn off
 *   POST /api/v1/connected-apps/:id/sync               sync now
 *   POST /api/v1/connected-apps/android-contacts/import  contacts picked on the phone
 *
 * Every route needs a verified member (requireAuth); the member only ever
 * acts on their own apps.
 */

import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { CONNECTED_APP_IDS } from '../services/connected-apps/catalogue';
import {
  connectApp,
  disconnectApp,
  importDeviceContacts,
  listApps,
  syncApp,
} from '../services/connected-apps/hub';

const router = Router();
router.use(requireAuth as any);
const LOG = '[connected-apps-api]';

function member(req: AuthenticatedRequest): { userId: string; tenantId: string } | null {
  const id = req.identity;
  if (!id?.user_id) return null;
  return { userId: id.user_id, tenantId: id.tenant_id || '00000000-0000-0000-0000-000000000000' };
}

function knownApp(id: string): boolean {
  return CONNECTED_APP_IDS.includes(id);
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const m = member(req);
  if (!m) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  try {
    return res.json({ ok: true, apps: await listApps(m.userId) });
  } catch (err: any) {
    console.error(`${LOG} list failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Must be declared before /:id/... so "android-contacts/import" is not read as an app action.
router.post('/android-contacts/import', async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the hub records this transition (connected_app.* events in services/connected-apps/hub.ts).
  const m = member(req);
  if (!m) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  try {
    const r = await importDeviceContacts(m.userId, (req.body?.contacts ?? []) as any[]);
    if (!r.ok) return res.status(r.status ?? 400).json(r);
    return res.json(r);
  } catch (err: any) {
    console.error(`${LOG} android import failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/:id/connect', async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the hub records this transition (connected_app.* events in services/connected-apps/hub.ts).
  const m = member(req);
  if (!m) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  if (!knownApp(req.params.id)) return res.status(404).json({ ok: false, error: 'unknown_app' });
  try {
    const r = await connectApp(m.userId, m.tenantId, req.params.id, {
      returnMode: req.body?.return === 'mobile' || req.query.return === 'mobile' ? 'mobile' : 'web',
      appleId: typeof req.body?.apple_id === 'string' ? req.body.apple_id : undefined,
      appPassword: typeof req.body?.app_password === 'string' ? req.body.app_password : undefined,
    });
    if (!r.ok) return res.status(r.status ?? 400).json({ ok: false, error: r.error });
    return res.json(r);
  } catch (err: any) {
    console.error(`${LOG} connect ${req.params.id} failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/:id/disconnect', async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the hub records this transition (connected_app.* events in services/connected-apps/hub.ts).
  const m = member(req);
  if (!m) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  if (!knownApp(req.params.id)) return res.status(404).json({ ok: false, error: 'unknown_app' });
  try {
    const r = await disconnectApp(m.userId, req.params.id, { removeData: req.body?.remove_data === true });
    if (!r.ok) return res.status(r.status ?? 400).json(r);
    return res.json(r);
  } catch (err: any) {
    console.error(`${LOG} disconnect ${req.params.id} failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/:id/sync', async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: a sync is not an on/off transition — its result lands on connected_app_settings, and a failure emits connected_app.sync_failed in the hub.
  const m = member(req);
  if (!m) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  if (!knownApp(req.params.id)) return res.status(404).json({ ok: false, error: 'unknown_app' });
  try {
    const apps = await listApps(m.userId);
    if (apps.find((a) => a.id === req.params.id)?.status !== 'on') {
      return res.status(409).json({ ok: false, error: 'app_off' });
    }
    const r = await syncApp(m.userId, req.params.id);
    return res.status(r.ok ? 200 : 502).json(r);
  } catch (err: any) {
    console.error(`${LOG} sync ${req.params.id} failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

export default router;
