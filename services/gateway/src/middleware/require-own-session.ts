/**
 * VTID-04933 — writes that need a person's own session.
 *
 * Extracted from routes/admin-partner-terms.ts (VTID-04895) so the admin
 * review routes use the same check: an AI assistant's delegated OAuth token is
 * refused, only the signed-in person's own session may publish terms or
 * approve, reject or hold a supplier. Must run after requireAuth.
 */
import { Request, Response, NextFunction } from 'express';
import { getSupabase } from '../lib/supabase';
import { requestDelegation } from '../services/partner-terms';
import type { AuthenticatedRequest } from './auth-supabase-jwt';

export async function requireOwnSession(req: Request, res: Response, next: NextFunction) {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const verdict = await requestDelegation(supabase, (req as AuthenticatedRequest).auth_raw_claims as Record<string, unknown> | undefined);
  if (verdict !== 'direct') return res.status(403).json({ ok: false, error: 'REQUIRES_OWN_SESSION' });
  return next();
}
