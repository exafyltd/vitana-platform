/**
 * VTID-02047 Phase 5: 3rd-party Connection Manager scaffold
 *
 * Mounted at /api/v1/admin/specialists/:key/connections.
 *
 * v1 stores connection records keyed by persona + provider. Real adapters
 * (Stripe live, Auth0 live, Zendesk) are deferred — the UI lets operators
 * see connection state, add a stub, and "test" it. The test always returns
 * "would do X" until real executor code is wired.
 *
 *   GET    /:key/connections         list this persona's connections
 *   POST   /:key/connections         { provider, config? } — creates
 *   DELETE /:id/connections          remove connection by id
 *   POST   /connections/:id/test     run a stub health check
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const router = Router();

const SUPPORTED_PROVIDERS = ['stripe-stub', 'auth0-stub', 'zendesk-stub'] as const;

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!,
    { auth: { persistSession: false, autoRefreshToken: false } });
}
function getBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}
function decodeJwtSub(token: string): string | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub ?? null; }
  catch { return null; }
}
function ensureAuth(req: Request, res: Response): string | null {
  const token = getBearerToken(req);
  if (!token) { res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' }); return null; }
  const userId = decodeJwtSub(token);
  if (!userId) { res.status(401).json({ ok: false, error: 'INVALID_TOKEN' }); return null; }
  return userId;
}

router.get('/personas/:key/connections', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data: persona } = await supabase.from('agent_personas').select('id').eq('key', req.params.key).maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });
  const { data, error } = await supabase
    .from('agent_third_party_connections')
    .select('id, provider, status, last_check_at, created_at')
    .eq('persona_id', persona.id);
  if (error) return res.status(502).json({ ok: false, error: error.message });
  return res.json({ ok: true, supported_providers: SUPPORTED_PROVIDERS, connections: data ?? [] });
});

const AddSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
});

router.post('/personas/:key/connections', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = AddSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });
  const supabase = getServiceClient();
  const { data: persona } = await supabase.from('agent_personas').select('id').eq('key', req.params.key).maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'PERSONA_NOT_FOUND' });

  const { data, error } = await supabase
    .from('agent_third_party_connections')
    .insert({ persona_id: persona.id, provider: v.data.provider, status: 'draft', created_by: userId })
    .select('*')
    .single();
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });

  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    persona_id: persona.id,
    action: 'connection_add',
    after_state: { provider: v.data.provider, connection_id: data.id },
  });
  return res.status(201).json({ ok: true, connection: data });
});

router.delete('/connections/:id', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const supabase = getServiceClient();
  const { data: existing } = await supabase.from('agent_third_party_connections').select('*').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const { error } = await supabase.from('agent_third_party_connections').delete().eq('id', req.params.id);
  if (error) return res.status(502).json({ ok: false, error: error.message });
  await supabase.from('agent_audit_log').insert({
    actor_user_id: userId,
    persona_id: existing.persona_id,
    action: 'connection_remove',
    before_state: existing,
  });
  return res.json({ ok: true });
});

router.post('/connections/:id/test', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data: conn } = await supabase.from('agent_third_party_connections').select('*').eq('id', req.params.id).maybeSingle();
  if (!conn) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  // Stub adapter: always succeeds with "would do X"
  const adapter_response = {
    provider: conn.provider,
    healthy: true,
    note: `Stub adapter — real ${conn.provider.replace('-stub', '')} executor not yet wired. Would call provider API in production.`,
  };
  await supabase.from('agent_third_party_connections').update({ status: 'active', last_check_at: new Date().toISOString() }).eq('id', conn.id);
  return res.json({ ok: true, ...adapter_response });
});

export default router;
