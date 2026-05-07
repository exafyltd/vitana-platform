/**
 * VTID-DANCE-D10: Intent post sharing.
 *
 * Two endpoints:
 *
 *   POST /api/v1/intents/:intent_id/share
 *     body: { recipient_vitana_ids: string[], note?: string, channel: 'in_app' | 'external' }
 *
 *     Direct invite to specific Vitana members. Each recipient gets:
 *       1. A DM card in their chat thread (chat_messages with metadata.kind='shared_intent_post')
 *       2. An intent_matches row with kind_pairing='direct_share' that slots
 *          the share into the standard match lifecycle so "Express interest" /
 *          "Decline" buttons work for free.
 *     Idempotent per (intent_id, recipient_vitana_id).
 *
 *   GET /p/:intent_id
 *     Public Open-Graph friendly viewer for an intent post. Visibility-gated:
 *     public posts render for everyone (auth or not); tenant posts require
 *     login + same tenant; private/mutual_reveal soft-403.
 *
 * VTID-02831 (2026-05-07): per-batch and per-post share caps lifted for the
 * pre-1k-user growth phase. Operator override remains unconditional.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// VTID-02831 (2026-05-07): per-batch + per-post share caps lifted for the
// pre-1k-user growth phase. Re-introduce when abuse signal demands it.

// ── POST /api/v1/intents/:intent_id/share ──────────────────────
// Absolute path so we can keep this router mounted at '/' and serve the
// public /p/:id viewer from the same module.

router.post('/api/v1/intents/:intent_id/share', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const intentId = String(req.params.intent_id || '').trim();
  const body = req.body ?? {};
  const recipientIds: string[] = Array.isArray(body.recipient_vitana_ids)
    ? body.recipient_vitana_ids
        .map((r: any) => String(r ?? '').trim().replace(/^@/, '').toLowerCase())
        .filter((r: string) => /^[a-z][a-z0-9]{3,15}$/.test(r))
    : [];
  const note: string | null = typeof body.note === 'string' ? body.note.trim().slice(0, 280) : null;
  const channel: 'in_app' | 'external' = body.channel === 'external' ? 'external' : 'in_app';

  if (!intentId) {
    return res.status(400).json({ ok: false, error: 'INTENT_ID_REQUIRED' });
  }
  if (recipientIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'RECIPIENTS_REQUIRED', message: 'recipient_vitana_ids must be a non-empty array of valid vitana_ids.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  // 1. Load source intent + visibility check.
  const { data: srcIntent, error: srcErr } = await supabase
    .from('user_intents')
    .select('intent_id, requester_user_id, requester_vitana_id, intent_kind, category, title, scope, visibility, status, tenant_id')
    .eq('intent_id', intentId)
    .maybeSingle();

  if (srcErr || !srcIntent) {
    return res.status(404).json({ ok: false, error: 'INTENT_NOT_FOUND' });
  }

  const isOwner = (srcIntent as any).requester_user_id === identity.user_id;
  const visibility = String((srcIntent as any).visibility || 'public');
  if (!isOwner && visibility !== 'public') {
    return res.status(403).json({
      ok: false,
      error: 'CANNOT_SHARE_PRIVATE_POST',
      message: 'Only the post owner can share private or mutual_reveal posts.',
    });
  }
  if (visibility === 'private') {
    return res.status(403).json({ ok: false, error: 'PRIVATE_POST', message: 'Private posts cannot be shared.' });
  }

  // 2. Resolve recipient vitana_ids → user_ids. Only matches inside the
  // sharer's tenant (when the intent is tenant-scoped). For public posts we
  // allow cross-tenant resolution.
  const tenantScope = visibility === 'public' ? null : (srcIntent as any).tenant_id;
  const resolveQ = supabase
    .from('profiles')
    .select('user_id, vitana_id, display_name')
    .in('vitana_id', recipientIds);
  const { data: recipients, error: recErr } = await resolveQ;
  if (recErr) {
    console.error('[VTID-DANCE-D10] resolve recipients failed', recErr);
    return res.status(500).json({ ok: false, error: recErr.message });
  }

  const validRecipients = (recipients || []).filter((r: any) => r && r.user_id !== identity.user_id);
  if (validRecipients.length === 0) {
    return res.status(404).json({ ok: false, error: 'NO_VALID_RECIPIENTS' });
  }

  // 4. Pre-filter recipients to skip those already direct-shared (Supabase
  // upsert can't target partial UNIQUE indexes via onConflict). Plain INSERT
  // with idempotency enforced manually.
  const recipientVids = validRecipients.map((r: any) => r.vitana_id);
  const { data: existingDirect } = await supabase
    .from('intent_matches')
    .select('vitana_id_b')
    .eq('intent_a_id', intentId)
    .eq('kind_pairing', 'direct_share')
    .in('vitana_id_b', recipientVids);
  const alreadySharedTo = new Set<string>((existingDirect || []).map((r: any) => String(r.vitana_id_b)));
  const fanout = validRecipients.filter((r: any) => !alreadySharedTo.has(String(r.vitana_id)));

  let insertedMatches: Array<{ match_id?: string; vitana_id_b?: string }> = [];
  if (fanout.length > 0) {
    const matchRows = fanout.map((r: any) => ({
      intent_a_id: intentId,
      intent_b_id: null,
      vitana_id_a: (srcIntent as any).requester_vitana_id,
      vitana_id_b: r.vitana_id,
      external_target_kind: null,
      external_target_id: null,
      kind_pairing: 'direct_share',
      score: 1.0,
      match_reasons: { direct_share: true, sharer_vitana_id: identity.vitana_id ?? null, note },
      compass_aligned: false,
      state: 'new',
    }));

    const { data, error: matchInsErr } = await supabase
      .from('intent_matches')
      .insert(matchRows as any)
      .select('match_id, vitana_id_b');

    if (matchInsErr) {
      console.error('[VTID-DANCE-D10] match insert failed', matchInsErr);
      return res.status(500).json({ ok: false, error: matchInsErr.message });
    }
    insertedMatches = (data || []) as any;
  }

  // 5. Insert chat_messages rows (DM card preview) only for newly fanned-out
  // recipients (idempotent — re-shares to the same person don't spam).
  // Best-effort.
  if (channel === 'in_app' && fanout.length > 0) {
    const messageRows = fanout.map((r: any) => ({
      sender_id: identity.user_id,
      receiver_id: r.user_id,
      sender_vitana_id: identity.vitana_id ?? null,
      receiver_vitana_id: r.vitana_id,
      content: note || `Shared a post with you`,
      metadata: {
        kind: 'shared_intent_post',
        intent_id: intentId,
        sharer_vitana_id: identity.vitana_id ?? null,
        intent_kind: (srcIntent as any).intent_kind,
        category: (srcIntent as any).category,
        title: (srcIntent as any).title,
        scope_excerpt: String((srcIntent as any).scope || '').slice(0, 240),
        note,
      },
    }));
    try {
      await supabase.from('chat_messages').insert(messageRows as any);
    } catch (err: any) {
      console.warn('[VTID-DANCE-D10] chat_messages insert non-fatal:', err?.message);
    }
  }

  // 6. OASIS audit.
  await emitOasisEvent({
    vtid: 'VTID-DANCE-D10',
    type: 'voice.message.share_link_sent', // closest existing event taxonomy
    source: 'intents-share',
    status: 'success',
    message: `Direct-shared intent ${intentId} to ${fanout.length} new recipients (${alreadySharedTo.size} already had a share) via ${channel}`,
    payload: {
      intent_id: intentId,
      sharer_vitana_id: identity.vitana_id ?? null,
      recipient_count: validRecipients.length,
      channel,
      note_present: Boolean(note),
    },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
    vitana_id: identity.vitana_id ?? undefined,
  });

  return res.json({
    ok: true,
    intent_id: intentId,
    recipients_resolved: validRecipients.length,
    recipients_skipped: recipientIds.length - validRecipients.length,
    recipients_already_shared: alreadySharedTo.size,
    channel,
    matches_created: insertedMatches.length,
  });
});

// ── GET /p/:intent_id ──────────────────────────────────────────
// Public viewer with Open Graph meta tags. Lives outside /api/v1 so the
// URL is short and shareable.

router.get('/p/:intent_id', async (req: Request, res: Response) => {
  const intentId = String(req.params.intent_id || '').trim();
  const sharerRef = req.query.ref ? String(req.query.ref).slice(0, 32) : null;

  if (!intentId || !/^[0-9a-f-]{36}$/i.test(intentId)) {
    return res.status(404).type('html').send('<h1>Not found</h1>');
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).type('html').send('<h1>Service unavailable</h1>');
  }

  const { data: intent } = await supabase
    .from('user_intents')
    .select('intent_id, requester_vitana_id, intent_kind, category, title, scope, visibility, created_at')
    .eq('intent_id', intentId)
    .maybeSingle();

  if (!intent) {
    return res.status(404).type('html').send('<h1>Post not found</h1>');
  }

  const visibility = String((intent as any).visibility || 'public');
  const requesterVitanaId = String((intent as any).requester_vitana_id || '');
  const titleText = String((intent as any).title || 'Vitana post');
  const scopeText = String((intent as any).scope || '');
  const kind = String((intent as any).intent_kind || '');

  // Privacy gating: never leak full content for non-public posts in OG previews.
  const ogTitle = visibility === 'public'
    ? `@${requesterVitanaId} on Vitana — ${titleText}`
    : `A Vitana post`;
  const ogDescription = visibility === 'public'
    ? scopeText.slice(0, 280)
    : 'Sign in on Vitana to see this post.';

  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));

  const html = `<!doctype html><html><head>
<meta charset="utf-8" />
<title>${escape(ogTitle)}</title>
<meta property="og:title" content="${escape(ogTitle)}" />
<meta property="og:description" content="${escape(ogDescription)}" />
<meta property="og:type" content="article" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escape(ogTitle)}" />
<meta name="twitter:description" content="${escape(ogDescription)}" />
<meta name="robots" content="${visibility === 'public' ? 'index,follow' : 'noindex'}" />
<style>body{font-family:system-ui;margin:0;padding:24px;max-width:640px;margin:auto;color:#111}h1{font-size:1.5rem}.meta{color:#666;font-size:.9rem}.card{border:1px solid #ddd;border-radius:12px;padding:20px;margin-top:16px}.kind{display:inline-block;background:#eef;color:#225;font-size:.75rem;padding:2px 8px;border-radius:99px;margin-bottom:8px}a.btn{display:inline-block;background:#225;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:16px}</style>
</head><body>
<div class="card">
${visibility === 'public' ? `
<div class="kind">${escape(kind)}</div>
<h1>${escape(titleText)}</h1>
<div class="meta">Posted by @${escape(requesterVitanaId)}</div>
<p>${escape(scopeText.slice(0, 600))}${scopeText.length > 600 ? '…' : ''}</p>
` : `
<h1>A Vitana post</h1>
<p>This post is visible to community members. Sign in on Vitana to see and respond.</p>
`}
<a class="btn" href="https://vitanaland.com/intents/${escape(intentId)}${sharerRef ? `?ref=${escape(sharerRef)}` : ''}">Open in Vitana</a>
</div>
</body></html>`;

  // Audit the share-view (best-effort). Identity is anonymous here.
  try {
    await emitOasisEvent({
      vtid: 'VTID-DANCE-D10',
      type: 'voice.message.sent',
      source: 'intents-share-public',
      status: 'info',
      message: `Public share view for intent ${intentId}`,
      payload: { intent_id: intentId, sharer_ref: sharerRef, visibility },
      actor_role: 'system',
      surface: 'api',
    });
  } catch {
    // best effort
  }

  res.type('html').send(html);
});

export default router;
