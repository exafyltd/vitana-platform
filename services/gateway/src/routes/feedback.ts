/**
 * VTID-02047: Unified Feedback Pipeline — ingestion endpoint (parent plan PR 1)
 *
 * Single inbox for user-originated signals: bug reports, support questions,
 * marketplace claims, account issues, feature requests, freeform feedback.
 *
 * Public endpoints (router mounted at /api/v1/feedback/tickets):
 * - POST /api/v1/feedback/tickets       — create a ticket from mobile capture
 * - GET  /api/v1/feedback/tickets/mine  — list current user's tickets
 *
 * Mounted under /tickets because /api/v1/feedback is already taken by the
 * VTID-01121 feedback-correction router (User Feedback, Correction & Trust
 * Repair Engine — different concept, same word). The two co-exist via the
 * sub-prefix.
 *
 * Plan: .claude/plans/unified-feedback-pipeline.md
 *
 * Voice intake (Phase 1 PR 3-5) and async classifier (PR 6) land in later PRs.
 * This PR only ships the foundation: schema + ingestion + own-ticket read.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';
import { resolveVitanaId } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-02047';

// =============================================================================
// Schema
// =============================================================================

const FEEDBACK_KINDS = [
  'bug',
  'ux_issue',
  'support_question',
  'account_issue',
  'marketplace_claim',
  'feature_request',
  'feedback',
] as const;

const CreateTicketSchema = z.object({
  // The user (or their voice transcript) describes the issue here.
  raw_text: z.string().min(1).max(10_000).optional(),
  raw_transcript: z.string().min(1).max(20_000).optional(),

  // Optional kind hint from the client. Classifier worker (PR 6) is the
  // authoritative source — the hint just speeds up Phase 1 routing.
  kind: z.enum(FEEDBACK_KINDS).optional(),

  // Capture context
  screen_path: z.string().max(500).optional(),
  app_version: z.string().max(64).optional(),
  device_meta: z.record(z.unknown()).optional(),
  screenshot_url: z.string().url().max(2_000).optional(),

  // For voice intake (Phase 1 PR 3+), the front-end can pass the per-turn
  // transcript array. Schema is open so we don't churn this PR when voice
  // ships. The classifier reads `intake_messages` if present.
  intake_messages: z.array(z.object({
    agent: z.string().max(32),
    role: z.enum(['user', 'assistant']),
    content: z.string().max(10_000),
    ts: z.string().datetime().optional(),
  })).max(60).optional(),

  // Structured fields filled by the specialist intake agent during voice
  // capture. Open shape per kind — see plan for kind-specific schemas.
  structured_fields: z.record(z.unknown()).optional(),
}).refine(
  v => Boolean(v.raw_text) || Boolean(v.raw_transcript) || (v.intake_messages && v.intake_messages.length > 0),
  { message: 'At least one of raw_text, raw_transcript, or intake_messages is required' }
);

const ListMineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().datetime().optional(), // created_at lower bound for pagination
});

// =============================================================================
// Helpers
// =============================================================================

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function decodeJwtSub(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

// =============================================================================
// POST / — create a ticket  (public path: POST /api/v1/feedback/tickets)
// =============================================================================

router.post('/', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const userId = decodeJwtSub(token);
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }

  const validation = CreateTicketSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const body = validation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'GATEWAY_MISCONFIGURED' });
  }

  // Resolve vitana_id at insert time so triage queries don't need a join.
  // Null-tolerant per resolveVitanaId() contract — store NULL if not yet mirrored.
  const vitanaId = await resolveVitanaId(userId);

  const supabase = createUserSupabaseClient(token);

  const insertRow: Record<string, unknown> = {
    user_id: userId,
    vitana_id: vitanaId,
    kind: body.kind ?? 'feedback',
    status: body.intake_messages && body.intake_messages.length > 0 ? 'triaged' : 'new',
    raw_transcript: body.raw_transcript ?? body.raw_text ?? null,
    intake_messages: body.intake_messages ?? [],
    structured_fields: body.structured_fields ?? {},
    screenshot_url: body.screenshot_url ?? null,
    screen_path: body.screen_path ?? null,
    app_version: body.app_version ?? null,
    device_meta: body.device_meta ?? null,
  };

  const { data, error } = await supabase
    .from('feedback_tickets')
    .insert(insertRow)
    .select('id, ticket_number, status, kind, created_at')
    .single();

  if (error) {
    console.error(`[${VTID}] insert feedback_ticket failed:`, error.message);
    return res.status(502).json({ ok: false, error: 'INSERT_FAILED', details: error.message });
  }

  // Fire-and-forget OASIS event so the supervisor inbox + any future routine
  // pick it up. Failure here must not block the user response.
  emitOasisEvent({
    vtid: VTID,
    type: 'feedback.ticket.created' as any,
    source: 'feedback-gateway',
    status: 'info',
    message: `Feedback ticket ${data.ticket_number} created (${data.kind})`,
    payload: {
      ticket_id: data.id,
      ticket_number: data.ticket_number,
      kind: data.kind,
      status: data.status,
      has_screenshot: Boolean(body.screenshot_url),
      has_intake_messages: Boolean(body.intake_messages?.length),
      screen_path: body.screen_path ?? null,
      app_version: body.app_version ?? null,
    },
    actor_id: userId,
    actor_role: 'user',
    surface: 'api',
    vitana_id: vitanaId ?? undefined,
  }).catch(err => console.warn(`[${VTID}] OASIS emit failed:`, err?.message));

  return res.status(201).json({
    ok: true,
    id: data.id,
    ticket_number: data.ticket_number,
    status: data.status,
    kind: data.kind,
    created_at: data.created_at,
  });
});

// =============================================================================
// GET /mine — list current user's tickets  (public: GET /api/v1/feedback/tickets/mine)
// =============================================================================

router.get('/mine', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const validation = ListMineQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }
  const { limit, cursor } = validation.data;

  const supabase = createUserSupabaseClient(token);

  let query = supabase
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, priority, surface, created_at, resolver_agent, resolved_at, user_confirmed_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt('created_at', cursor);
  }

  const { data, error } = await query;

  if (error) {
    console.error(`[${VTID}] list mine failed:`, error.message);
    return res.status(502).json({ ok: false, error: 'QUERY_FAILED', details: error.message });
  }

  return res.json({
    ok: true,
    tickets: data ?? [],
    next_cursor: data && data.length === limit ? data[data.length - 1].created_at : null,
  });
});

export default router;
