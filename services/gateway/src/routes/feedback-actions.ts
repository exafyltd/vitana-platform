/**
 * VTID-02047: Unified Feedback Pipeline — supervisor + user actions
 * Parent plan PRs 8-12 bundle.
 *
 * Two routers exported:
 *   adminRouter — mount at /api/v1/admin/feedback. Routes:
 *     POST /tickets/:id/draft-answer     Sage placeholder
 *     POST /tickets/:id/draft-spec       Devon placeholder
 *     POST /tickets/:id/draft-resolution Mira/Atlas placeholder
 *     POST /tickets/:id/send-answer      flips to resolved
 *     POST /tickets/:id/approve          flips to in_progress
 *     POST /tickets/:id/resolve          flips to resolved
 *     POST /tickets/:id/reject           flips to rejected
 *     POST /tickets/:id/mark-duplicate   links to canonical
 *
 *   userRouter — mount at /api/v1/feedback/tickets. Routes:
 *     POST /:id/confirm                  user confirms resolution worked
 *     POST /:id/reopen                   user says it didn't work
 *
 * v1 LLM drafting is a placeholder — real Sage/Devon/Atlas/Mira agents
 * land in the next layer. The skeleton here lets the inbox drawer wire
 * up working buttons and the routine auto-actions land cleanly.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';
import * as repo from './feedback-actions-repository';

const VTID = 'VTID-02047';

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
function emitFeedbackEvent(type: string, ticket: Record<string, unknown>, payload: Record<string, unknown> = {}, actorId?: string) {
  emitOasisEvent({
    vtid: VTID,
    type: type as any,
    source: 'feedback-actions-gateway',
    status: 'info',
    message: `${type} for ${ticket.ticket_number ?? ticket.id}`,
    payload: { ticket_id: ticket.id, ticket_number: ticket.ticket_number, ...payload },
    actor_id: actorId,
    actor_role: actorId ? 'operator' : 'system',
    surface: 'command-hub',
    vitana_id: (ticket.vitana_id as string) ?? undefined,
  }).catch(err => console.warn(`[${VTID}] OASIS emit ${type} failed:`, err?.message));
}

// ===========================================================================
// ADMIN ROUTER
// ===========================================================================

export const adminRouter = Router();

const DraftSchema = z.object({ notes: z.string().max(2000).optional() });
const ReasonSchema = z.object({ reason: z.string().max(500).optional() });
const DuplicateSchema = z.object({ duplicate_of: z.string().uuid() });

// VTID-02047: real LLM drafts via callViaRouter (Sage / Devon / Mira / Atlas).
// On router failure each helper falls back to a clearly-labelled placeholder
// so the supervisor can still move the ticket forward.
async function loadTicketSnapshot(id: string) {
  const { data } = await repo.fetchTicketSnapshot(getServiceClient(), id);
  return data;
}

adminRouter.post('/tickets/:id/draft-answer', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const v = DraftSchema.safeParse(req.body); if (!v.success) return res.status(400).json({ ok: false });

  const snap = await loadTicketSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { llmDraftSageAnswer } = await import('../services/feedback-llm-resolvers');
  const draft = await llmDraftSageAnswer(snap as any);

  const { data, error } = await repo.updateTicketDraftAnswer(getServiceClient(), req.params.id, {
    status: 'answer_ready',
    resolver_agent: 'sage',
    draft_answer_md: draft.markdown + (v.data.notes ? `\n\n---\n_Supervisor notes:_ ${v.data.notes}` : ''),
  });
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'answer_ready', resolver_agent: 'sage', draft_provider: draft.provider }, actor ?? undefined);
  return res.json({ ok: true, ticket: data, draft_provider: draft.provider });
});

adminRouter.post('/tickets/:id/draft-spec', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const v = DraftSchema.safeParse(req.body); if (!v.success) return res.status(400).json({ ok: false });

  const snap = await loadTicketSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { llmDraftDevonSpec } = await import('../services/feedback-llm-resolvers');
  const draft = await llmDraftDevonSpec(snap as any);

  const { data, error } = await repo.updateTicketDraftSpec(getServiceClient(), req.params.id, {
    status: 'spec_ready',
    resolver_agent: 'devon',
    spec_md: draft.markdown + (v.data.notes ? `\n\n---\n_Supervisor notes:_ ${v.data.notes}` : ''),
  });
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'spec_ready', resolver_agent: 'devon', draft_provider: draft.provider }, actor ?? undefined);
  return res.json({ ok: true, ticket: data, draft_provider: draft.provider });
});

adminRouter.post('/tickets/:id/draft-resolution', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const v = DraftSchema.safeParse(req.body); if (!v.success) return res.status(400).json({ ok: false });

  const snap = await loadTicketSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const resolver = snap.kind === 'marketplace_claim' ? 'atlas' : 'mira';
  const { llmDraftAtlasResolution, llmDraftMiraResolution } = await import('../services/feedback-llm-resolvers');
  const draft = resolver === 'atlas'
    ? await llmDraftAtlasResolution(snap as any)
    : await llmDraftMiraResolution(snap as any);

  const { data, error } = await repo.updateTicketDraftResolution(getServiceClient(), req.params.id, {
    status: 'spec_ready',
    resolver_agent: resolver,
    resolution_md: draft.markdown + (v.data.notes ? `\n\n---\n_Supervisor notes:_ ${v.data.notes}` : ''),
  });
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'spec_ready', resolver_agent: resolver, draft_provider: draft.provider }, actor ?? undefined);
  return res.json({ ok: true, ticket: data, draft_provider: draft.provider });
});

adminRouter.post('/tickets/:id/approve', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const { data, error } = await repo.approveTicket(getServiceClient(), req.params.id);
  if (error || !data) return res.status(409).json({ ok: false, error: 'NOT_APPROVABLE', details: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'in_progress', from: 'approve' }, actor ?? undefined);
  return res.json({ ok: true, ticket: data });
});

adminRouter.post('/tickets/:id/send-answer', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const { data, error } = await repo.sendAnswerTicket(getServiceClient(), req.params.id, {
    status: 'resolved',
    resolved_at: new Date().toISOString(),
    auto_resolved: false,
  });
  if (error || !data) return res.status(409).json({ ok: false, error: 'NOT_SENDABLE', details: error?.message });
  emitFeedbackEvent('feedback.ticket.resolved', data, { from: 'send-answer', resolver_agent: data.resolver_agent }, actor ?? undefined);
  return res.json({ ok: true, ticket: data });
});

adminRouter.post('/tickets/:id/resolve', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const { data, error } = await repo.resolveTicket(getServiceClient(), req.params.id, {
    status: 'resolved',
    resolved_at: new Date().toISOString(),
  });
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });
  emitFeedbackEvent('feedback.ticket.resolved', data, { from: 'manual-resolve' }, actor ?? undefined);
  return res.json({ ok: true, ticket: data });
});

adminRouter.post('/tickets/:id/reject', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const v = ReasonSchema.safeParse(req.body); if (!v.success) return res.status(400).json({ ok: false });
  const { data, error } = await repo.rejectTicket(getServiceClient(), req.params.id, {
    status: 'rejected',
    supervisor_notes: v.data.reason ?? null,
  });
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'rejected', reason: v.data.reason ?? null }, actor ?? undefined);
  return res.json({ ok: true, ticket: data });
});

adminRouter.post('/tickets/:id/mark-duplicate', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const actor = decodeJwtSub(token);
  const v = DuplicateSchema.safeParse(req.body); if (!v.success) return res.status(400).json({ ok: false });
  const { data, error } = await repo.markDuplicateTicket(getServiceClient(), req.params.id, {
    status: 'duplicate',
    duplicate_of: v.data.duplicate_of,
  });
  if (error || !data) return res.status(502).json({ ok: false, error: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'duplicate', duplicate_of: v.data.duplicate_of }, actor ?? undefined);
  return res.json({ ok: true, ticket: data });
});

// ===========================================================================
// USER ROUTER
// ===========================================================================

export const userRouter = Router();

userRouter.post('/:id/confirm', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const userId = decodeJwtSub(token); if (!userId) return res.status(401).json({ ok: false });
  const supabase = createUserSupabaseClient(token);
  const { data, error } = await repo.confirmUserTicket(supabase, req.params.id, userId, {
    status: 'user_confirmed',
    user_confirmed_at: new Date().toISOString(),
  });
  if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_OWNER', details: error?.message });
  emitFeedbackEvent('feedback.ticket.user_confirmed', data, {}, userId);
  return res.json({ ok: true, ticket: data });
});

userRouter.post('/:id/reopen', async (req: Request, res: Response) => {
  const token = getBearerToken(req); if (!token) return res.status(401).json({ ok: false });
  const userId = decodeJwtSub(token); if (!userId) return res.status(401).json({ ok: false });
  const supabase = createUserSupabaseClient(token);
  const { data, error } = await repo.reopenUserTicket(supabase, req.params.id, userId, {
    status: 'reopened',
    priority: 'p1',
  });
  if (error || !data) return res.status(409).json({ ok: false, error: 'NOT_REOPENABLE', details: error?.message });
  emitFeedbackEvent('feedback.ticket.status_changed', data, { new_status: 'reopened', from: 'user-reopen' }, userId);
  return res.json({ ok: true, ticket: data });
});

export default adminRouter;
