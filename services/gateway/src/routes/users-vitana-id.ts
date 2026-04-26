/**
 * VTID-01967: Vitana ID onboarding pick endpoints.
 *
 *   GET  /api/v1/users/me/vitana-id/suggestion
 *        Returns 3 fresh suggestions from generate_vitana_id_suggestion().
 *
 *   POST /api/v1/users/me/vitana-id/confirm   body: { vitana_id }
 *        ONE-SHOT — only callable when profiles.vitana_id_locked = false.
 *        On success: writes previous auto-generated value to handle_aliases,
 *        updates vitana_id (and the legacy handle mirror) to the new value,
 *        sets vitana_id_locked = true. After lock: 409 Conflict on every
 *        subsequent call. Mutability is permanent — there is intentionally
 *        no PATCH endpoint after this.
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  invalidateVitanaIdCache,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { createClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

const VITANA_ID_REGEX = /^[a-z][a-z0-9]{3,11}$/;
const MIN_LETTERS = 2;
const MIN_DIGITS = 2;

// ── GET /me/vitana-id/suggestion ──────────────────────────────

router.get('/me/vitana-id/suggestion', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();

  // Fetch the user's display_name + email for the generator. (full_name in
  // profiles is the user-friendly name; falls back to email prefix.)
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('display_name, full_name, email, vitana_id_locked')
    .eq('user_id', identity.user_id)
    .maybeSingle();

  if (profileRow && (profileRow as any).vitana_id_locked) {
    return res.status(409).json({
      ok: false,
      error: 'ALREADY_LOCKED',
      message: 'Your Vitana ID is already set and cannot be changed.',
    });
  }

  // Three suggestions — three independent RPC calls. Each gets its own
  // random suffix internally, so the trio is naturally distinct.
  const [s1, s2, s3] = await Promise.all([
    supabase.rpc('generate_vitana_id_suggestion', {
      p_display_name: profileRow?.display_name ?? null,
      p_full_name: profileRow?.full_name ?? null,
      p_email: profileRow?.email ?? identity.email ?? null,
    }),
    supabase.rpc('generate_vitana_id_suggestion', {
      p_display_name: profileRow?.display_name ?? null,
      p_full_name: profileRow?.full_name ?? null,
      p_email: profileRow?.email ?? identity.email ?? null,
    }),
    supabase.rpc('generate_vitana_id_suggestion', {
      p_display_name: profileRow?.display_name ?? null,
      p_full_name: profileRow?.full_name ?? null,
      p_email: profileRow?.email ?? identity.email ?? null,
    }),
  ]);

  // Dedupe in case the random suffixes happened to collide.
  const suggestions = Array.from(
    new Set([s1.data, s2.data, s3.data].filter(Boolean))
  );

  return res.json({
    ok: true,
    suggestions,
  });
});

// ── POST /me/vitana-id/confirm ────────────────────────────────

router.post('/me/vitana-id/confirm', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { vitana_id: requestedRaw } = req.body ?? {};

  if (!requestedRaw || typeof requestedRaw !== 'string') {
    return res.status(400).json({ ok: false, error: 'vitana_id is required' });
  }

  // Normalize: strip leading @, lowercase. Same rules as the resolver.
  const requested = requestedRaw.trim().replace(/^@/, '').toLowerCase();

  // Format check.
  if (!VITANA_ID_REGEX.test(requested)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_FORMAT',
      message: 'Vitana ID must start with a letter, then 3-11 lowercase letters or digits.',
    });
  }

  // Composition check (≥2 letters AND ≥2 digits).
  const letters = (requested.match(/[a-z]/g) || []).length;
  const digits = (requested.match(/[0-9]/g) || []).length;
  if (letters < MIN_LETTERS || digits < MIN_DIGITS) {
    return res.status(400).json({
      ok: false,
      error: 'WEAK_COMPOSITION',
      message: `Vitana ID needs at least ${MIN_LETTERS} letters and ${MIN_DIGITS} digits.`,
    });
  }

  const supabase = getSupabase();

  // Reserved-word check (single source of truth in vitana_id_reserved table).
  const { data: reserved } = await supabase
    .from('vitana_id_reserved')
    .select('token')
    .eq('token', requested)
    .maybeSingle();
  if (reserved) {
    return res.status(400).json({
      ok: false,
      error: 'RESERVED_TOKEN',
      message: 'That Vitana ID is reserved. Please choose another.',
    });
  }

  // Read current row + lock state.
  const { data: current, error: currentErr } = await supabase
    .from('profiles')
    .select('vitana_id, vitana_id_locked')
    .eq('user_id', identity.user_id)
    .maybeSingle();

  if (currentErr || !current) {
    return res.status(404).json({
      ok: false,
      error: 'PROFILE_NOT_FOUND',
      message: 'Profile row not found.',
    });
  }

  if ((current as any).vitana_id_locked) {
    return res.status(409).json({
      ok: false,
      error: 'ALREADY_LOCKED',
      message: 'Your Vitana ID is already set and cannot be changed.',
    });
  }

  const previous = (current as any).vitana_id as string | null;

  // Uniqueness pre-check (definitive check is the UNIQUE index on UPDATE).
  if (previous !== requested) {
    const { data: taken } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('vitana_id', requested)
      .neq('user_id', identity.user_id)
      .maybeSingle();
    if (taken) {
      return res.status(409).json({
        ok: false,
        error: 'TAKEN',
        message: 'That Vitana ID is already taken. Please choose another.',
      });
    }

    // Also check handle_aliases — collisions are protected here too so we
    // never re-issue an ID that historically pointed to a different user.
    const { data: aliasTaken } = await supabase
      .from('handle_aliases')
      .select('user_id')
      .eq('old_handle', requested)
      .neq('user_id', identity.user_id)
      .maybeSingle();
    if (aliasTaken) {
      return res.status(409).json({
        ok: false,
        error: 'ALIAS_COLLISION',
        message: 'That Vitana ID was previously used by another account. Please choose another.',
      });
    }

    // Park the previous auto-generated value in handle_aliases so /profiles
    // links and any in-flight references still resolve to this user.
    if (previous) {
      await supabase.from('handle_aliases').upsert(
        { old_handle: previous, user_id: identity.user_id },
        { onConflict: 'old_handle' }
      );
    }
  }

  // Update profiles. Mirror trigger fires -> app_users.vitana_id updates.
  // handle column also mirrored to keep frontend reads consistent under
  // the replace policy.
  const { error: updateErr } = await supabase
    .from('profiles')
    .update({
      vitana_id: requested,
      handle: requested,
      vitana_id_locked: true,
    })
    .eq('user_id', identity.user_id);

  if (updateErr) {
    console.error('[VTID-01967] vitana-id confirm update error:', updateErr);
    return res.status(500).json({ ok: false, error: updateErr.message });
  }

  // Invalidate the in-process cache so the next request sees the new value.
  invalidateVitanaIdCache(identity.user_id);

  // Audit event — vitana_id is now the canonical user identifier.
  await emitOasisEvent({
    vtid: 'VTID-01967',
    type: 'vitana_id.confirmed',
    source: 'users-vitana-id',
    status: 'success',
    message: `User confirmed Vitana ID @${requested}${previous ? ` (was @${previous})` : ''}`,
    payload: { previous, current: requested },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
    vitana_id: requested,
  });

  return res.json({
    ok: true,
    vitana_id: requested,
    vitana_id_locked: true,
  });
});

export default router;
