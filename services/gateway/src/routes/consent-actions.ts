/**
 * VTID-02300: Consent actions routes — user-facing API for the consent flow.
 *
 * GET  /api/v1/actions/pending  — list user's pending actions
 * POST /api/v1/actions/:id/approve
 * POST /api/v1/actions/:id/deny
 * GET  /api/v1/actions/permissions — user's action grants
 * POST /api/v1/actions/permissions/:action_type/revoke
 */

import { Router, Request, Response } from 'express';
import * as jose from 'jose';
import {
  getUserPendingActions,
  approvePendingAction,
  denyPendingAction,
} from '../services/consent-gate';
import { getSupabase } from '../lib/supabase';

const router = Router();

function getUser(req: Request): { user_id: string; tenant_id: string | null } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const claims = jose.decodeJwt(token);
    const user_id = typeof claims.sub === 'string' ? claims.sub : null;
    if (!user_id) return null;
    const app_metadata = (claims as { app_metadata?: { active_tenant_id?: string } }).app_metadata;
    return { user_id, tenant_id: app_metadata?.active_tenant_id ?? null };
  } catch {
    return null;
  }
}

router.get('/pending', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const actions = await getUserPendingActions(user.user_id);
  res.json({ ok: true, actions });
});

router.post('/:id/approve', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const result = await approvePendingAction(req.params.id, user.user_id);
  res.json(result);
});

router.post('/:id/deny', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const result = await denyPendingAction(req.params.id, user.user_id);
  res.json(result);
});

router.get('/permissions', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await supabase
    .from('user_action_permissions')
    .select('*')
    .eq('user_id', user.user_id)
    .order('granted_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, permissions: data ?? [] });
});

router.post('/permissions/:action_type/revoke', async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { error } = await supabase
    .from('user_action_permissions')
    .update({ granted: false, revoked_at: new Date().toISOString() })
    .eq('user_id', user.user_id)
    .eq('action_type', req.params.action_type);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

export default router;
