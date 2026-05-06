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
import { enrichDancePayload } from '../services/intent-dance-helper';
import { embedIntent } from '../services/intent-embedding';
import {
  CoverGenError,
  generateCoverForIntent,
  themeFromCategory,
} from '../services/intent-cover-service';
import { computeForIntent, surfaceTopMatches } from '../services/intent-matcher';
// VTID-DANCE-D12 — Layer 2 over the SQL matcher.
import { runMatchmakerAsync } from '../services/matchmaker-agent';
import { checkIntentContent } from '../services/intent-content-filter';
import { canPostIntent } from '../services/intent-throttle';
import { gateCommercialBudget } from '../services/intent-tier-gate';
import { gateIntentByTier } from '../services/intent-trust-gate';
import { enrichMatchesWithCounterpartyProfiles } from '../services/intent-match-enrich';
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
  // VTID-DANCE-D2
  'learning_seek', 'mentor_seek',
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

  // VTID-DANCE-D2: dance facet enrichment (no-op for non-dance categories).
  // Canonicalises any dance.* fields in kind_payload + back-fills from
  // profile.dance_preferences when the user has set them.
  kindPayload = await enrichDancePayload({
    user_id: identity.user_id,
    category,
    kind_payload: kindPayload,
  });

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

  // VTID-DANCE-D14 — De-duplication (two-tier).
  //
  //   FAST RULE: same user + same intent_kind + same category + last 15
  //   minutes → ALWAYS dedup. The user clearly meant the same thing they
  //   just posted. No content matching needed.
  //
  //   WIDER RULE: last 24 hours, same kind, same category, status='open',
  //   AND title-substring-match OR scope-substring-match (>=80%). Catches
  //   cases where the user paraphrases ("looking for a dance partner"
  //   then "want to dance with someone").
  //
  // Both rules return deduplicated:true with the existing intent_id. The
  // voice tool description tells Gemini to surface the existing post via
  // navigate_to_screen instead of trying to post again.
  {
    const supabase = getSupabase();
    // Pull the requester's open intents from the same kind in the last 24h.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('user_intents')
      .select('intent_id, requester_vitana_id, title, scope, category, kind_payload, created_at')
      .eq('requester_user_id', identity.user_id)
      .eq('intent_kind', intentKind)
      .eq('status', 'open')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20);

    const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const newTitle = norm(title);
    const newScope = norm(scope);
    const FIFTEEN_MIN_AGO = Date.now() - 15 * 60 * 1000;

    const dup = (existing as any[] ?? []).find((r) => {
      // FAST RULE: same kind + same category + last 15 minutes → dedup unconditionally.
      const rCreatedAt = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (rCreatedAt > FIFTEEN_MIN_AGO && r.category === category) {
        return true;
      }

      // WIDER RULE: same kind + 24h + textual similarity.
      const rTitle = norm(r.title);
      const rScope = norm(r.scope);
      // Title overlap.
      if (rTitle && newTitle && (rTitle === newTitle || rTitle.includes(newTitle) || newTitle.includes(rTitle))) {
        return true;
      }
      // Scope substring match (>=80% of either side).
      if (rScope && newScope) {
        const minLen = Math.min(rScope.length, newScope.length);
        if (minLen > 30 && (rScope.includes(newScope.slice(0, Math.floor(newScope.length * 0.8))) ||
                            newScope.includes(rScope.slice(0, Math.floor(rScope.length * 0.8))))) {
          return true;
        }
      }
      return false;
    });

    if (dup) {
      await emitOasisEvent({
        vtid: 'VTID-DANCE-D14',
        type: 'voice.message.sent',
        source: 'intents-route',
        status: 'info',
        message: `De-dup blocked duplicate intent post (kind=${intentKind})`,
        payload: { intent_kind: intentKind, existing_intent_id: dup.intent_id, requester_vitana_id: identity.vitana_id },
        actor_id: identity.user_id,
        actor_role: 'user',
        surface: 'api',
        vitana_id: identity.vitana_id ?? undefined,
      });
      return res.status(200).json({
        ok: true,
        deduplicated: true,
        intent_id: dup.intent_id,
        requester_vitana_id: dup.requester_vitana_id,
        message: 'You already posted a similar request in the last 24 hours. Returning the existing post — refine it (different time, location, or style) if you want a new one.',
      });
    }
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

  // Tier gate (commercial only — legacy budget-based check kept for backwards compat).
  if ((intentKind === 'commercial_buy' || intentKind === 'commercial_sell') && typeof budgetMax === 'number') {
    const gate = await gateCommercialBudget(identity.user_id, budgetMax);
    if (!gate.ok) {
      return res.status(403).json({ ok: false, error: 'TIER_REQUIRED', tier: gate.tier, required: gate.required, message: gate.reason });
    }
  }

  // VTID-DANCE-D6: per-kind/category trust-tier gate (data-driven via
  // intent_tier_required). Operator role bypasses entirely.
  const isOperator = Boolean((identity as any).exafy_admin) || (identity as any).role === 'service_role';
  const trustGate = await gateIntentByTier({
    user_id: identity.user_id,
    intent_kind: intentKind,
    category,
    kind_payload: kindPayload,
    is_operator: isOperator,
  });
  if (!trustGate.ok) {
    return res.status(403).json({
      ok: false,
      error: 'INSUFFICIENT_TRUST_TIER',
      required: trustGate.required_tier,
      current: trustGate.current_tier,
      message: trustGate.reason,
    });
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

  // BOOTSTRAP-INTENT-COVER-GEN — settle the cover photo for this new intent.
  //   • If the form composer transited a `kind_payload.cover_url` (user
  //     uploaded their own photo), promote it to the dedicated column and
  //     stamp source = 'user_upload'.
  //   • Otherwise fire-and-forget AI generation. Voice posts hit this branch.
  //
  // Both paths are non-blocking so the post response stays fast.
  const userProvidedCover =
    typeof (kindPayload as Record<string, unknown> | undefined)?.cover_url === 'string'
      ? ((kindPayload as Record<string, unknown>).cover_url as string)
      : null;
  if (userProvidedCover) {
    void supabase
      .from('user_intents')
      .update({ cover_url: userProvidedCover, cover_source: 'user_upload' })
      .eq('intent_id', (inserted as any).intent_id)
      .then(({ error }) => {
        if (error) console.warn('[cover] user-provided promote failed:', error.message);
      });
  } else {
    void generateCoverForIntent({
      intentId: (inserted as any).intent_id,
      userId: identity.user_id,
      theme: themeFromCategory(category),
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.warn(`[cover] auto-gen failed for ${(inserted as any).intent_id}: ${msg}`);
    });
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

  // VTID-DANCE-D12 — Layer 2 matchmaker agent (Gemini 2.5 Pro), async.
  // Kicks off a background re-rank. Clients poll
  // GET /api/v1/intents/:id/matchmaker for the polished result (~20s).
  // The SQL match_count + intent_id are returned NOW so voice flow
  // doesn't block on Gemini latency.
  try {
    runMatchmakerAsync((inserted as any).intent_id);
  } catch (err: any) {
    console.warn(`[VTID-DANCE-D12] matchmaker async kick failed (non-fatal): ${err?.message}`);
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
    // D12 async: status is 'pending' immediately after post. Poll
    // GET /api/v1/intents/:id/matchmaker for the polished re-rank.
    matchmaker_status: 'pending',
  });
});

// ── GET /intents/:id/matchmaker (D12 poll endpoint) ─────────

router.get('/:id/matchmaker', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const intentId = String(req.params.id || '').trim();
  if (!intentId) return res.status(400).json({ ok: false, error: 'INTENT_ID_REQUIRED' });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  // Visibility gate: requester must own the intent OR the intent is public.
  const { data: src } = await supabase
    .from('user_intents')
    .select('intent_id, requester_user_id, visibility')
    .eq('intent_id', intentId)
    .maybeSingle();
  if (!src) return res.status(404).json({ ok: false, error: 'INTENT_NOT_FOUND' });

  const isOwner = (src as any).requester_user_id === identity.user_id;
  const visibility = String((src as any).visibility || 'public');
  if (!isOwner && visibility !== 'public') {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  }

  const { data: rec } = await supabase
    .from('intent_match_recommendations')
    .select('intent_id, status, mode, pool_size, candidates, counter_questions, voice_readback, reasoning_summary, used_fallback, model, latency_ms, error, computed_at, updated_at')
    .eq('intent_id', intentId)
    .maybeSingle();

  if (!rec) {
    return res.json({ ok: true, status: 'not_started', poll_again_ms: 2000 });
  }

  const status = String((rec as any).status);
  return res.json({
    ok: true,
    status,
    mode: (rec as any).mode,
    pool_size: (rec as any).pool_size,
    candidates: (rec as any).candidates ?? [],
    counter_questions: (rec as any).counter_questions ?? [],
    voice_readback: (rec as any).voice_readback,
    reasoning_summary: (rec as any).reasoning_summary,
    used_fallback: (rec as any).used_fallback,
    model: (rec as any).model,
    latency_ms: (rec as any).latency_ms,
    error: (rec as any).error,
    computed_at: (rec as any).computed_at,
    // Tell the client when to poll again (only if still computing).
    poll_again_ms: status === 'pending' || status === 'running' ? 3000 : null,
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
  // Apply mutual-reveal redaction + counterparty profile enrichment (E6).
  const enriched = await enrichMatchesWithCounterpartyProfiles(matches, identity.user_id);
  return res.json({ ok: true, matches: enriched });
});

// ── POST /intents/:id/cover/generate ─────────────────────────
//
// Explicit user request to (re)generate the cover photo for an intent
// the caller owns. Body: { force?: boolean }. Status codes:
//   200  → { cover_url, source, cached }
//   401  → unauthorized
//   403  → not the owner
//   404  → no such intent
//   429  → daily regen quota exceeded

router.post('/:id/cover/generate', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { data: row } = await supabase
    .from('user_intents')
    .select('intent_id, requester_user_id, category')
    .eq('intent_id', req.params.id)
    .maybeSingle();
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if ((row as { requester_user_id: string }).requester_user_id !== identity.user_id) {
    return res.status(403).json({ ok: false, error: 'not_owner' });
  }

  try {
    const result = await generateCoverForIntent({
      intentId: (row as { intent_id: string }).intent_id,
      userId: identity.user_id,
      theme: themeFromCategory((row as { category: string | null }).category),
      force: Boolean((req.body ?? {}).force),
    });

    // OASIS: record the cover-photo state transition. Cached hits are
    // silent (no real change); regenerations / first generations emit.
    if (!result.cached) {
      // Reuses the same generic event type other handlers in this
      // router emit through; the discriminator lives in `message` +
      // `payload.kind`. Non-fatal — never let telemetry block the
      // user-facing response.
      await emitOasisEvent({
        vtid: 'BOOTSTRAP-INTENT-COVER-GEN',
        type: 'voice.message.sent',
        source: 'intents-route',
        status: 'info',
        message: 'intent.cover.generated',
        payload: {
          kind: 'intent.cover.generated',
          intent_id: (row as { intent_id: string }).intent_id,
          theme: themeFromCategory((row as { category: string | null }).category),
          cover_source: result.source,
          forced: Boolean((req.body ?? {}).force),
        },
        actor_id: identity.user_id,
        actor_role: 'user',
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.warn(`[cover] oasis emit non-fatal: ${msg}`);
      });
    }

    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof CoverGenError) {
      const status =
        err.code === 'rate_limited' ? 429
        : err.code === 'forbidden' ? 403
        : err.code === 'not_found' ? 404
        : 500;
      return res.status(status).json({ ok: false, error: err.code, message: err.message });
    }
    const msg = err instanceof Error ? err.message : 'unknown';
    return res.status(500).json({ ok: false, error: 'cover_gen_failed', message: msg });
  }
});

export default router;
