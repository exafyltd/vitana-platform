/**
 * Admin Content Moderation API — Moderation Reports
 *
 * Endpoints:
 * - GET  /reports  — List moderation reports (placeholder — returns [] until content_reports table exists)
 *
 * Security:
 * - All endpoints require Bearer token + exafy_admin
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();
const VTID = 'ADMIN-MODERATION';

// ── Auth Helper ─────────────────────────────────────────────

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

async function verifyExafyAdmin(
  req: Request
): Promise<{ ok: true; user_id: string; email: string } | { ok: false; status: number; error: string }> {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'UNAUTHENTICATED' };

  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) return { ok: false, status: 401, error: 'INVALID_TOKEN' };

    const appMetadata = authData.user.app_metadata || {};
    if (appMetadata.exafy_admin !== true) {
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }

    return { ok: true, user_id: authData.user.id, email: authData.user.email || 'unknown' };
  } catch (err: any) {
    console.error(`[${VTID}] Auth error:`, err.message);
    return { ok: false, status: 500, error: 'INTERNAL_ERROR' };
  }
}

// ── GET /reports — List moderation reports ───────────────────

router.get('/reports', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  // No content_reports table exists yet — return empty array
  // When a content_reports table is created, this will query it
  console.log(`[${VTID}] Reports requested — no content_reports table yet, returning empty`);
  return res.json({ ok: true, reports: [] });
});

export default router;
