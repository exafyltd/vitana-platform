/**
 * VTID-01967 + VTID-01987: Vitana ID onboarding pick endpoints.
 *
 *   GET  /api/v1/users/me/vitana-id/suggestion
 *        Returns the user's current vitana_id + registration_seq + 3 base
 *        alternatives. The seq is fixed (allocated at signup, the user's
 *        registration rank); only the base portion is editable.
 *
 *   POST /api/v1/users/me/vitana-id/confirm   body: { base } | { vitana_id }
 *        ONE-SHOT — only callable when profiles.vitana_id_locked = false.
 *        Accepts either { base } (v2, suffix is forced from registration_seq)
 *        or { vitana_id } (legacy, accepted for one release with deprecation
 *        warning) — the suffix part is enforced to match registration_seq
 *        either way. On success: parks the previous auto-generated value in
 *        handle_aliases, updates vitana_id (and the legacy handle mirror) to
 *        the new value, sets vitana_id_locked = true. After lock: 409 on
 *        every subsequent call.
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

// v2 format: <base><seq>. Total 4-16 chars. The base alone is 2-8 chars and
// must match BASE_REGEX; the suffix is the user's registration_seq (digits).
const VITANA_ID_REGEX_V2 = /^[a-z][a-z0-9]{3,15}$/;
const BASE_REGEX = /^[a-z][a-z0-9]{1,7}$/;

// Lightweight base normalizer — strips @ + non-base chars + lowercases. Returns
// '' if the input has no usable base prefix.
function normalizeBase(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Split a vitana_id into { base, seq }. Returns null if it doesn't end in
// digits (shouldn't happen post-v2, but the legacy format has digits too).
function splitVitanaId(v: string): { base: string; seq: number } | null {
  const m = v.match(/^([a-z][a-z0-9]*?)([0-9]+)$/);
  if (!m) return null;
  return { base: m[1], seq: parseInt(m[2], 10) };
}

// ── GET /me/vitana-id/suggestion ──────────────────────────────

router.get('/me/vitana-id/suggestion', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();

  const { data: profileRow } = await supabase
    .from('profiles')
    .select('display_name, full_name, email, vitana_id, vitana_id_locked, registration_seq')
    .eq('user_id', identity.user_id)
    .maybeSingle();

  if (profileRow && (profileRow as any).vitana_id_locked) {
    return res.status(409).json({
      ok: false,
      error: 'ALREADY_LOCKED',
      message: 'Your Vitana ID is already set and cannot be changed.',
    });
  }

  const current = (profileRow as any)?.vitana_id as string | undefined;
  const seq = (profileRow as any)?.registration_seq as number | undefined;

  // Build 3 base alternatives from display_name / full_name / email-local.
  // Truncate each to 8 chars. Dedupe + filter to BASE_REGEX-valid bases.
  const sources: string[] = [
    (profileRow as any)?.display_name ?? '',
    (profileRow as any)?.full_name ?? '',
    (((profileRow as any)?.email ?? identity.email ?? '') as string).split('@')[0] ?? '',
  ];

  const candidateBases = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    const parts = src.split(/\s+/).filter(Boolean);
    for (const part of parts) {
      const norm = normalizeBase(part).replace(/^[0-9]+/, '');
      if (norm.length >= 2) {
        candidateBases.add(norm.slice(0, 8));
      }
    }
  }

  // Always include the current base as the first alternative.
  const currentSplit = current ? splitVitanaId(current) : null;
  const baseAlternatives: string[] = [];
  if (currentSplit?.base) baseAlternatives.push(currentSplit.base);
  for (const b of candidateBases) {
    if (BASE_REGEX.test(b) && !baseAlternatives.includes(b)) {
      baseAlternatives.push(b);
    }
    if (baseAlternatives.length >= 3) break;
  }

  return res.json({
    ok: true,
    data: {
      current,
      registration_seq: seq,
      base_alternatives: baseAlternatives,
    },
    // Legacy field — keep filled for one release for backwards-compatible clients.
    suggestions: current ? [current] : [],
  });
});

// ── POST /me/vitana-id/confirm ────────────────────────────────

router.post('/me/vitana-id/confirm', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const body = req.body ?? {};
  const supabase = getSupabase();

  // Read current row + lock state + seq.
  const { data: current, error: currentErr } = await supabase
    .from('profiles')
    .select('vitana_id, vitana_id_locked, registration_seq')
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
  const seq = (current as any).registration_seq as number | null;

  if (!seq) {
    // Defensive: any post-v2 user has registration_seq populated. If this
    // fires for a real user it means the v2 backfill missed them.
    return res.status(409).json({
      ok: false,
      error: 'NO_REGISTRATION_SEQ',
      message: 'Your account is missing a registration sequence number. Please contact support.',
    });
  }

  // Resolve the user's chosen base. Two accepted shapes:
  //   { base: "alex" }            — v2 native
  //   { vitana_id: "alex25" }     — legacy; suffix MUST equal registration_seq
  let base: string;
  if (typeof body.base === 'string') {
    base = body.base.trim().replace(/^@/, '').toLowerCase();
  } else if (typeof body.vitana_id === 'string') {
    const requested = body.vitana_id.trim().replace(/^@/, '').toLowerCase();
    if (!VITANA_ID_REGEX_V2.test(requested)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_FORMAT',
        message: 'Vitana ID must start with a letter and be 4-16 lowercase letters or digits.',
      });
    }
    const split = splitVitanaId(requested);
    if (!split) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_FORMAT',
        message: 'Vitana ID must end in digits matching your registration number.',
      });
    }
    if (split.seq !== seq) {
      return res.status(400).json({
        ok: false,
        error: 'SUFFIX_LOCKED',
        message: `Your Vitana ID suffix is locked to your registration number ${seq}. You can only change the name part.`,
      });
    }
    base = split.base;
  } else {
    return res.status(400).json({
      ok: false,
      error: 'BASE_REQUIRED',
      message: 'Provide a `base` (the name portion of your Vitana ID).',
    });
  }

  // Validate base shape.
  if (!BASE_REGEX.test(base)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BASE',
      message: 'Base must start with a letter and be 2-8 lowercase letters or digits.',
    });
  }

  // Reserved-word check against the canonical reserved table.
  const { data: reserved } = await supabase
    .from('vitana_id_reserved')
    .select('token')
    .eq('token', base)
    .maybeSingle();
  if (reserved) {
    return res.status(400).json({
      ok: false,
      error: 'RESERVED_TOKEN',
      message: 'That name is reserved. Please choose another.',
    });
  }

  const requested = `${base}${seq}`;

  // Final format check (defense in depth — should always pass).
  if (!VITANA_ID_REGEX_V2.test(requested)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_FORMAT',
      message: 'Computed Vitana ID is invalid; pick a shorter base.',
    });
  }

  // Uniqueness pre-check (definitive guard is the UNIQUE index on UPDATE).
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
        message: 'That Vitana ID is already taken. Try a different name.',
      });
    }

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
        message: 'That Vitana ID was previously used by another account. Try a different name.',
      });
    }

    if (previous) {
      await supabase.from('handle_aliases').upsert(
        { old_handle: previous, user_id: identity.user_id },
        { onConflict: 'old_handle' }
      );
    }
  }

  const { error: updateErr } = await supabase
    .from('profiles')
    .update({
      vitana_id: requested,
      handle: requested,
      vitana_id_locked: true,
    })
    .eq('user_id', identity.user_id);

  if (updateErr) {
    console.error('[VTID-01987] vitana-id confirm update error:', updateErr);
    return res.status(500).json({ ok: false, error: updateErr.message });
  }

  invalidateVitanaIdCache(identity.user_id);

  await emitOasisEvent({
    vtid: 'VTID-01987',
    type: 'vitana_id.confirmed',
    source: 'users-vitana-id',
    status: 'success',
    message: `User confirmed Vitana ID @${requested}${previous ? ` (was @${previous})` : ''}`,
    payload: { previous, current: requested, registration_seq: seq, base },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
    vitana_id: requested,
  });

  return res.json({
    ok: true,
    vitana_id: requested,
    vitana_id_locked: true,
    registration_seq: seq,
  });
});

export default router;
