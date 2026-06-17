/**
 * VTID-03277 — Guided Journey checklist PUBLIC read (P2).
 *
 *   GET /api/v1/journey-checklist  → the published curriculum My Journey renders.
 *
 * Returns the current published snapshot; falls back to the enabled working
 * draft when nothing is published yet (early-phase bootstrap). User-facing
 * fields only — internal admin fields are stripped by toPublicTopic.
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  getPublishedChecklist,
  type ChecklistLocale,
} from '../services/guided-journey/checklist-service';
import { getUserLocale } from '../i18n/server-locale';

const router = Router();
const VTID = 'VTID-03277';

const SUPPORTED_LOCALES: readonly ChecklistLocale[] = ['de', 'en', 'es', 'sr'];

/** Resolve the curriculum locale: an explicit `?locale=` (the live UI language,
 *  authoritative) wins; otherwise fall back to the user's stored profile locale. */
async function resolveLocale(
  req: AuthenticatedRequest,
  client: Parameters<typeof getUserLocale>[0],
  userId: string,
): Promise<ChecklistLocale> {
  const raw = String(req.query.locale ?? '').slice(0, 5).toLowerCase().split('-')[0];
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as ChecklistLocale;
  try {
    return (await getUserLocale(client, userId)) as ChecklistLocale;
  } catch {
    return 'de';
  }
}

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.identity?.user_id) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const c = getSupabase();
  if (!c) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }
  try {
    const curriculumVersion = (req.query.curriculumVersion as string) || 'v2';
    const locale = await resolveLocale(req, c, req.identity.user_id);
    const result = await getPublishedChecklist(c, curriculumVersion, locale);
    return res.json({
      ok: true,
      source: result.source,
      versionLabel: result.versionLabel,
      locale,
      topics: result.topics,
      count: result.topics.length,
      vtid: VTID,
    });
  } catch (err: any) {
    console.error(`[${VTID}] published checklist read failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'read_failed', vtid: VTID });
  }
});

export default router;
