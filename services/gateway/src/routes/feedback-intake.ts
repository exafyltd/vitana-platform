/**
 * VTID-02603: Unified Feedback Pipeline — intake & handoff bridge
 * Parent plan PR 3-5 bundle.
 *
 * Endpoints (mounted under /api/v1/feedback/intake):
 * - POST /handoff-detect      — given a user opener, return the matching
 *                               specialist (Devon/Sage/Atlas/Mira) or null
 *                               for "stay with Vitana".
 * - POST /start               — create a feedback_tickets row in
 *                               'interviewing' status, log the Vitana →
 *                               specialist handoff event, return persona +
 *                               ticket_id so the frontend can swap voice.
 * - POST /turn                — append one user/assistant turn to the
 *                               in-flight ticket's intake_messages.
 * - POST /complete            — flip status to 'triaged', set
 *                               structured_fields, log wrap-back handoff.
 *
 * The voice channel swap happens in the frontend (vitana-v1) — this gateway
 * code is the data plane: detection, ticket lifecycle, handoff events.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';
import { resolveVitanaId } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-02603';

const KIND_BY_AGENT: Record<string, string> = {
  devon: 'bug',
  sage: 'support_question',
  atlas: 'marketplace_claim',
  mira: 'account_issue',
};

function getBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

function decodeJwtSub(token: string): string | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// POST /handoff-detect
// ---------------------------------------------------------------------------

const DetectSchema = z.object({
  text: z.string().min(1).max(2000),
  conversation_id: z.string().max(120).optional(),
});

router.post('/handoff-detect', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const v = DetectSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  const supabase = createUserSupabaseClient(token);
  const { data, error } = await supabase.rpc('pick_specialist_for_text', { p_text: v.data.text });

  if (error) {
    console.error(`[${VTID}] pick_specialist RPC error:`, error.message);
    return res.status(502).json({ ok: false, error: 'RPC_FAILED', details: error.message });
  }

  const row = Array.isArray(data) ? data[0] : data;
  // Two-gate RPC returns: decision, persona_key, matched_phrase, gate, confidence.
  // decision='answer_inline' (any gate) → stay with Vitana.
  // decision='forward' / gate='topic'   → swap to row.persona_key.
  const decision: string = row?.decision ?? (row?.persona_key ? 'forward' : 'answer_inline');
  const gate: string = row?.gate ?? (row?.persona_key ? 'topic' : 'forward_request');
  const matchedPhrase: string | null = row?.matched_phrase ?? row?.matched_keyword ?? null;

  if (decision !== 'forward' || !row?.persona_key) {
    return res.json({
      ok: true,
      handoff: false,
      persona_key: 'vitana',
      decision,
      gate,
      matched_phrase: matchedPhrase,
    });
  }
  return res.json({
    ok: true,
    handoff: true,
    persona_key: row.persona_key,
    matched_keyword: matchedPhrase,
    matched_phrase: matchedPhrase,
    score: row.score ?? null,
    confidence: row.confidence,
    decision,
    gate,
    suggested_kind: KIND_BY_AGENT[row.persona_key] ?? null,
  });
});

// ---------------------------------------------------------------------------
// POST /start
// ---------------------------------------------------------------------------

const StartSchema = z.object({
  conversation_id: z.string().max(120).optional(),
  to_persona: z.enum(['devon', 'sage', 'atlas', 'mira']),
  detected_intent: z.string().max(500).optional(),
  matched_keyword: z.string().max(200).optional(),
  confidence: z.number().min(0).max(1).optional(),
  initial_user_text: z.string().min(1).max(10_000),
  screen_path: z.string().max(500).optional(),
  app_version: z.string().max(64).optional(),
  device_meta: z.record(z.unknown()).optional(),
});

router.post('/start', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const userId = decodeJwtSub(token);
  if (!userId) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });

  const v = StartSchema.safeParse(req.body);
  if (!v.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED',
      details: v.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') });
  }
  const body = v.data;
  const vitanaId = await resolveVitanaId(userId);
  const supabase = createUserSupabaseClient(token);

  const initialMessages = [
    { agent: 'vitana', role: 'user' as const, content: body.initial_user_text, ts: new Date().toISOString() },
  ];

  // Create ticket in 'interviewing' state
  const { data: ticket, error: insErr } = await supabase
    .from('feedback_tickets')
    .insert({
      user_id: userId,
      vitana_id: vitanaId,
      kind: KIND_BY_AGENT[body.to_persona] ?? 'feedback',
      status: 'interviewing',
      raw_transcript: body.initial_user_text,
      intake_messages: initialMessages,
      structured_fields: {},
      screen_path: body.screen_path ?? null,
      app_version: body.app_version ?? null,
      device_meta: body.device_meta ?? null,
    })
    .select('id, ticket_number, kind, status')
    .single();

  if (insErr) {
    console.error(`[${VTID}] ticket insert failed:`, insErr.message);
    return res.status(502).json({ ok: false, error: 'INSERT_FAILED', details: insErr.message });
  }

  // Log handoff event (service role via REST; user RLS only allows SELECT)
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/feedback_handoff_events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE!}`,
    },
    body: JSON.stringify({
      conversation_id: body.conversation_id ?? null,
      ticket_id: ticket.id,
      user_id: userId,
      vitana_id: vitanaId,
      from_agent: 'vitana',
      to_agent: body.to_persona,
      reason: 'off_domain_intent',
      detected_intent: body.detected_intent ?? null,
      matched_keyword: body.matched_keyword ?? null,
      confidence: body.confidence ?? null,
    }),
  }).catch(err => console.warn(`[${VTID}] handoff event write failed:`, err?.message));

  // Fetch the persona for the frontend
  const { data: persona } = await supabase
    .from('agent_personas')
    .select('key, display_name, role, voice_id, system_prompt, intake_schema_ref, max_questions, max_duration_seconds')
    .eq('key', body.to_persona)
    .maybeSingle();

  emitOasisEvent({
    vtid: VTID,
    type: 'feedback.handoff.started' as any,
    source: 'feedback-intake-gateway',
    status: 'info',
    message: `Vitana handed off to ${body.to_persona} for ticket ${ticket.ticket_number}`,
    payload: {
      ticket_id: ticket.id,
      ticket_number: ticket.ticket_number,
      to_persona: body.to_persona,
      kind: ticket.kind,
      matched_keyword: body.matched_keyword ?? null,
      confidence: body.confidence ?? null,
    },
    actor_id: userId,
    actor_role: 'user',
    surface: 'orb',
    vitana_id: vitanaId ?? undefined,
  }).catch(err => console.warn(`[${VTID}] OASIS emit failed:`, err?.message));

  return res.status(201).json({
    ok: true,
    ticket_id: ticket.id,
    ticket_number: ticket.ticket_number,
    persona,
  });
});

// ---------------------------------------------------------------------------
// POST /turn
// ---------------------------------------------------------------------------

const TurnSchema = z.object({
  ticket_id: z.string().uuid(),
  agent: z.string().max(32),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(10_000),
});

router.post('/turn', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const v = TurnSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });
  const body = v.data;
  const supabase = createUserSupabaseClient(token);

  // Read current intake_messages (RLS = own ticket only)
  const { data: existing, error: readErr } = await supabase
    .from('feedback_tickets')
    .select('id, intake_messages, status')
    .eq('id', body.ticket_id)
    .maybeSingle();

  if (readErr || !existing) {
    return res.status(404).json({ ok: false, error: 'TICKET_NOT_FOUND' });
  }
  if (!['interviewing', 'needs_more_info'].includes(existing.status)) {
    return res.status(409).json({ ok: false, error: 'TICKET_NOT_INTERVIEWING', status: existing.status });
  }

  const messages = Array.isArray(existing.intake_messages) ? existing.intake_messages : [];
  messages.push({ ...body, ts: new Date().toISOString() });

  const { error: upErr } = await supabase
    .from('feedback_tickets')
    .update({ intake_messages: messages })
    .eq('id', body.ticket_id);

  if (upErr) {
    return res.status(502).json({ ok: false, error: 'UPDATE_FAILED', details: upErr.message });
  }
  return res.json({ ok: true, turn_count: messages.length });
});

// ---------------------------------------------------------------------------
// POST /complete
// ---------------------------------------------------------------------------

const CompleteSchema = z.object({
  ticket_id: z.string().uuid(),
  structured_fields: z.record(z.unknown()),
  raw_transcript: z.string().max(20_000).optional(),
  conversation_id: z.string().max(120).optional(),
  resolver_persona: z.enum(['devon', 'sage', 'atlas', 'mira']).optional(),
});

router.post('/complete', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const userId = decodeJwtSub(token);
  if (!userId) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });

  const v = CompleteSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });
  const body = v.data;
  const supabase = createUserSupabaseClient(token);

  const { data: updated, error: upErr } = await supabase
    .from('feedback_tickets')
    .update({
      status: 'triaged',
      structured_fields: body.structured_fields,
      raw_transcript: body.raw_transcript ?? undefined,
      interviewed_at: new Date().toISOString(),
      triaged_at: new Date().toISOString(),
      resolver_agent: body.resolver_persona ?? null,
    })
    .eq('id', body.ticket_id)
    .select('id, ticket_number, status, kind, vitana_id')
    .single();

  if (upErr || !updated) {
    return res.status(502).json({ ok: false, error: 'UPDATE_FAILED', details: upErr?.message });
  }

  // Wrap-back handoff event: specialist → vitana
  if (body.resolver_persona) {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/feedback_handoff_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE!}`,
      },
      body: JSON.stringify({
        conversation_id: body.conversation_id ?? null,
        ticket_id: updated.id,
        user_id: userId,
        vitana_id: updated.vitana_id,
        from_agent: body.resolver_persona,
        to_agent: 'vitana',
        reason: 'wrap_back',
      }),
    }).catch(err => console.warn(`[${VTID}] wrap-back handoff write failed:`, err?.message));
  }

  emitOasisEvent({
    vtid: VTID,
    type: 'feedback.handoff.completed' as any,
    source: 'feedback-intake-gateway',
    status: 'info',
    message: `Intake completed for ticket ${updated.ticket_number}`,
    payload: {
      ticket_id: updated.id,
      ticket_number: updated.ticket_number,
      kind: updated.kind,
      resolver_persona: body.resolver_persona ?? null,
      structured_fields_keys: Object.keys(body.structured_fields),
    },
    actor_id: userId,
    actor_role: 'user',
    surface: 'orb',
    vitana_id: updated.vitana_id ?? undefined,
  }).catch(err => console.warn(`[${VTID}] OASIS emit failed:`, err?.message));

  return res.json({
    ok: true,
    ticket_id: updated.id,
    ticket_number: updated.ticket_number,
    status: updated.status,
  });
});

export default router;
