/**
 * VTID-01973: Intents REST router (P2-A).
 *
 * Single endpoint for posting any intent_kind. The classifier + extractor
 * stack runs INSIDE post — clients can either:
 *   (a) Provide structured fields directly (typed form path), or
 *   (b) Provide just `utterance` and let the server classify + extract.
 *
 * No voice tools yet — those land in P2-B inside orb-live.ts. This route
 * surface is what the voice tool will eventually call.
 *
 *   POST   /api/v1/intents                  — create
 *   GET    /api/v1/intents                  — list mine (?kind, ?status)
 *   GET    /api/v1/intents/:id              — read one (visibility-checked)
 *   PATCH  /api/v1/intents/:id              — update (owner only)
 *   POST   /api/v1/intents/:id/close        — close (owner only)
 *   GET    /api/v1/intents/:id/matches      — top matches for this intent
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { classifyIntentKind, type IntentKind } from '../services/intent-classifier';
import { extractIntent } from '../services/intent-extractor';
import { embedIntent } from '../services/intent-embedding';
import { computeForIntent, surfaceTopMatches } from '../services/intent-matcher';
import { checkIntentContent } from '../services/intent-content-filter';
import { canPostIntent } from '../services/intent-throttle';
import { gateCommercialBudget } from '../services/intent-tier-gate';
import { redactMatchForReader } from '../services/intent-mutual-reveal';
import { notifyMatchSurfaced } from '../services/intent-notifier';
import { writeIntentFacts } from '../services/intent-memory-hooks';
import { getActiveCompassGoal } from '../services/intent-compass-lens';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

const VALID_KINDS: IntentKind[] = [
  'commercial_buy', 'commercial_sell', 'activity_seek',
  'partner_seek', 'social_seek', 'mutual_aid',
];

// ── POST /intents ────────────────────────────────────────────

router.post('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const body = req.body ?? {};
  let intentKind: IntentKind | null = body.intent_kind ?? null;
  let category: string | null = body.category ?? null;
  let title: string | null = body.title ?? null;
  let scope: string | null = body.scope ?? null;
  let kindPayload: Record<string, unknown> = body.kind_payload ?? {};
  let visibility: string | null = body.visibility ?? null;

  // Path B: utterance-only — run classifier + extractor.
  if (body.utterance && (!intentKind || !title || !scope)) {
    const utterance = String(body.utterance);
    if (!intentKind) {
      const cls = await classifyIntentKind(utterance);
      if (!cls.intent_kind || cls.confidence < 0.7) {
        return res.status(400).json({
          ok: false,
          error: 'CLASSIFY_LOW_CONFIDENCE',
          message: 'Could not confidently classify the utterance. Provide intent_kind explicitly or rephrase.',
          classifier_confidence: cls.confidence,
        });
      }
      intentKind = cls.intent_kind;
    }
    if (!title || !scope) {
      const extract = await extractIntent(utterance, intentKind);
      title = title ?? extract.title;
      scope = scope ?? extract.scope;
      category = category ?? extract.category;
      kindPayload = { ...extract.kind_payload, ...kindPayload };
      if (extract.missing_critical.length > 0 && extract.confidence < 0.8) {
        return res.status(422).json({
          ok: false,
          error: 'EXTRACT_INCOMPLETE',
          message: 'Single-shot extraction missed required fields. Provide them or fall back to slot-fill.',
          missing_critical: extract.missing_critical,
          extract_confidence: extract.confidence,
        });
      }
    }
  }

  // Validation.
  if (!intentKind || !VALID_KINDS.includes(intentKind)) {
    return res.status(400).json({ ok: false, error: 'invalid intent_kind' });
  }
  if (!title || title.length < 3 || title.length > 140) {
    return res.status(400).json({ ok: false, error: 'title must be 3-140 chars' });
  }
  if (!scope || scope.length < 20 || scope.length > 1500) {
    return res.status(400).json({ ok: false, error: 'scope must be 20-1500 chars' });
  }

  // Content filter.
  const cf = checkIntentContent({ kind: intentKind, title, scope });
  if (!cf.ok) {
    await emitOasisEvent({
      vtid: 'VTID-01973',
      type: 'voice.message.sent',
      source: 'intents-route',
      status: 'warning',
      message: 'Intent post blocked by content filter',
      payload: { reasons: cf.reasons, kind: intentKind },
      actor_id: identity.user_id,
      actor_role: 'user',
      surface: 'api',
      vitana_id: identity.vitana_id ?? undefined,
    });
    return res.status(422).json({ ok: false, error: 'CONTENT_FILTER_BLOCKED', reasons: cf.reasons });
  }

  // Throttle.
  const budgetMax = (kindPayload?.budget_max ?? null) as number | null;
  const throttle = await canPostIntent({
    userId: identity.user_id,
    kind: intentKind,
    budgetMaxEur: typeof budgetMax === 'number' ? budgetMax : null,
  });
  if (!throttle.ok) {
    return res.status(429).json({ ok: false, error: throttle.reason, message: throttle.detail });
  }

  // Tier gate (commercial only).
  if ((intentKind === 'commercial_buy' || intentKind === 'commercial_sell') && typeof budgetMax === 'number') {
    const gate = await gateCommercialBudget(identity.user_id, budgetMax);
    if (!gate.ok) {
      return res.status(403).json({ ok: false, error: 'TIER_REQUIRED', tier: gate.tier, required: gate.required, message: gate.reason });
    }
  }

  // Snapshot the user's active compass at post time (for telemetry).
  const compass = await getActiveCompassGoal(identity.user_id);

  const supabase = getSupabase();
  const { data: inserted, error: insErr } = await supabase
    .from('user_intents')
    .insert({
      requester_user_id: identity.user_id,
      tenant_id: identity.tenant_id,
      intent_kind: intentKind,
      category,
      title,
      scope,
      kind_payload: kindPayload,
      visibility: visibility ?? undefined,
      compass_alignment_at_post: compass?.category ?? null,
      status: 'open',
    })
    .select('intent_id, requester_vitana_id')
    .single();

  if (insErr || !inserted) {
    console.error('[VTID-01973] intents POST insert failed', insErr);
    return res.status(500).json({ ok: false, error: insErr?.message ?? 'insert_failed' });
  }

  // VTID-01992: Embedding path is now flag-controlled.
  //   FEATURE_INTENT_EMBEDDING_ASYNC=true  → skip inline; the embedding
  //                                         worker (intent-embedding-worker.ts)
  //                                         will pick up the row within ~5s.
  //   default (unset / false)              → keep inline behavior. Worker
  //                                         still runs as a safety net for
  //                                         rows that slip past inline.
  if (process.env.FEATURE_INTENT_EMBEDDING_ASYNC !== 'true') {
    const embedding = await embedIntent({ intent_kind: intentKind, category, title, scope, kind_payload: kindPayload });
    if (embedding) {
      await supabase.from('user_intents').update({ embedding: embedding as any }).eq('intent_id', (inserted as any).intent_id);
    }
  }

  // VTID-01975 (P2-B): kind-discriminated Memory Garden write hooks.
  // Fire-and-forget so the post path is never blocked by memory persistence.
  writeIntentFacts({
    user_id: identity.user_id,
    tenant_id: identity.tenant_id!,
    intent_kind: intentKind,
    category,
    title: title!,
    scope: scope!,
    kind_payload: kindPayload,
  }).catch((err) => console.warn(`[VTID-01975] writeIntentFacts non-fatal: ${err?.message}`));

  // Compute matches now (best-effort; daily recompute catches misses).
  let matchCount = 0;
  try {
    matchCount = await computeForIntent((inserted as any).intent_id);
    if (matchCount > 0) {
      const top = await surfaceTopMatches((inserted as any).intent_id, 5);
      // VTID-01975 (P2-B): real push fan-out replaces P2-A audit-only stub.
      for (const m of top) {
        await notifyMatchSurfaced({ match: m, kind: intentKind });
      }
    }
  } catch (err: any) {
    console.warn(`[VTID-01973] post-insert match compute failed: ${err.message}`);
  }

  await emitOasisEvent({
    vtid: 'VTID-01973',
    type: 'voice.message.sent',
    source: 'intents-route',
    status: 'success',
    message: `Intent posted: ${intentKind}`,
    payload: {
      intent_id: (inserted as any).intent_id,
      intent_kind: intentKind,
      category,
      match_count: matchCount,
      compass_alignment_at_post: compass?.category ?? null,
    },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
    vitana_id: identity.vitana_id ?? undefined,
  });

  return res.status(201).json({
    ok: true,
    intent_id: (inserted as any).intent_id,
    requester_vitana_id: (inserted as any).requester_vitana_id,
    match_count: matchCount,
  });
});

// ── GET /intents (mine) ──────────────────────────────────────

router.get('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const kind = req.query.kind as string | undefined;
  const status = req.query.status as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const supabase = getSupabase();
  let q = supabase
    .from('user_intents')
    .select('*')
    .eq('requester_user_id', identity.user_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (kind) q = q.eq('intent_kind', kind);
  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, intents: data ?? [] });
});

// ── GET /intents/:id ─────────────────────────────────────────

router.get('/:id', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { data: ok } = await supabase.rpc('can_read_intent', {
    p_reader: identity.user_id,
    p_intent_id: req.params.id,
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });

  const { data, error } = await supabase
    .from('user_intents')
    .select('*')
    .eq('intent_id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json({ ok: true, intent: data });
});

// ── PATCH /intents/:id (owner only — partial update) ─────────

router.patch('/:id', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const allowed = ['title', 'scope', 'kind_payload', 'category', 'status', 'visibility'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (req.body && k in req.body) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'no fields' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_intents')
    .update(patch as any)
    .eq('intent_id', req.params.id)
    .eq('requester_user_id', identity.user_id)
    .select('*')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'not_found_or_not_owner' });
  return res.json({ ok: true, intent: data });
});

// ── POST /intents/:id/close ──────────────────────────────────

router.post('/:id/close', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_intents')
    .update({ status: 'closed' })
    .eq('intent_id', req.params.id)
    .eq('requester_user_id', identity.user_id)
    .select('*')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'not_found_or_not_owner' });
  return res.json({ ok: true, intent: data });
});

// ── GET /intents/:id/matches ─────────────────────────────────

router.get('/:id/matches', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { data: canRead } = await supabase.rpc('can_read_intent', {
    p_reader: identity.user_id,
    p_intent_id: req.params.id,
  });
  if (!canRead) return res.status(404).json({ ok: false, error: 'not_found' });

  const matches = await surfaceTopMatches(req.params.id, Math.min(Number(req.query.limit) || 5, 20));
  // Apply mutual-reveal redaction.
  const redacted = await Promise.all(matches.map(m => redactMatchForReader(m, identity.user_id)));
  return res.json({ ok: true, matches: redacted });
});

export default router;
