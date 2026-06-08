/**
 * VTID-03277 — Guided Journey checklist ADMIN API (P2).
 *
 * Admin Pages -> Knowledge Base -> Checklist backend. Exafy-admin only. Edits
 * the working draft, validates, and publishes/rolls back the version My Journey
 * consumes.
 *
 *   GET    /api/v1/admin/journey-checklist/topics            list (filters)
 *   GET    /api/v1/admin/journey-checklist/topics/:id        one topic (full)
 *   POST   /api/v1/admin/journey-checklist/topics            create
 *   PATCH  /api/v1/admin/journey-checklist/topics/:id        update
 *   POST   /api/v1/admin/journey-checklist/topics/:id/disable {disabled}
 *   GET    /api/v1/admin/journey-checklist/validate          publish validation
 *   GET    /api/v1/admin/journey-checklist/versions          publish history
 *   POST   /api/v1/admin/journey-checklist/publish           {note?}
 *   POST   /api/v1/admin/journey-checklist/rollback          {versionId}
 *   GET    /api/v1/admin/journey-checklist/export            full working JSON
 */

import { Router, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  listTopics,
  getTopic,
  createTopic,
  updateTopic,
  setTopicDisabled,
  exportChecklist,
  type ListFilters,
} from '../services/guided-journey/checklist-service';
import { validateChecklist } from '../services/guided-journey/checklist-validator';
import {
  publishChecklist,
  rollbackChecklist,
  listVersions,
  ChecklistValidationError,
} from '../services/guided-journey/checklist-publish';

const router = Router();
const VTID = 'VTID-03277';

router.use(requireAuth, requireExafyAdmin);

function client(res: Response) {
  const c = getSupabase();
  if (!c) {
    res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
    return null;
  }
  return c;
}

function fail(res: Response, err: any, code = 'internal_error') {
  console.error(`[${VTID}] checklist-admin ${code}: ${err?.message}`);
  return res.status(500).json({ ok: false, error: code, vtid: VTID });
}

router.get('/topics', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const filters: ListFilters = {
      curriculumVersion: (req.query.curriculumVersion as string) || undefined,
      session: req.query.session ? Number(req.query.session) : undefined,
      chapterId: (req.query.chapterId as string) || undefined,
      status: (req.query.status as any) || undefined,
      businessGate: (req.query.businessGate as any) || undefined,
      search: (req.query.search as string) || undefined,
    };
    const topics = await listTopics(c, filters);
    return res.json({ ok: true, topics, count: topics.length, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'list_failed');
  }
});

router.get('/topics/:id', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const topic = await getTopic(c, req.params.id);
    if (!topic) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
    return res.json({ ok: true, topic, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'get_failed');
  }
});

router.post('/topics', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  const b = req.body || {};
  if (!b.topicId || b.session == null || b.position == null || !b.chapterId || !b.displayLabel) {
    return res.status(400).json({
      ok: false,
      error: 'missing_fields',
      detail: 'topicId, session, position, chapterId, displayLabel are required',
      vtid: VTID,
    });
  }
  try {
    const topic = await createTopic(c, b, req.identity!.user_id);
    return res.status(201).json({ ok: true, topic, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'create_failed');
  }
});

router.patch('/topics/:id', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const existing = await getTopic(c, req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
    const topic = await updateTopic(c, req.params.id, req.body || {}, req.identity!.user_id);
    return res.json({ ok: true, topic, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'update_failed');
  }
});

router.post('/topics/:id/disable', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  const disabled = req.body?.disabled !== false; // default true
  try {
    const existing = await getTopic(c, req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
    const topic = await setTopicDisabled(c, req.params.id, disabled, req.identity!.user_id);
    return res.json({ ok: true, topic, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'disable_failed');
  }
});

router.get('/validate', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const topics = await listTopics(c, { curriculumVersion: (req.query.curriculumVersion as string) || 'v2' });
    const result = validateChecklist(topics);
    return res.json({ ok: true, validation: result, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'validate_failed');
  }
});

router.get('/versions', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const versions = await listVersions(c, (req.query.curriculumVersion as string) || 'v2');
    return res.json({ ok: true, versions, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'versions_failed');
  }
});

router.post('/publish', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const { version, validation } = await publishChecklist(c, req.identity!.user_id, {
      curriculumVersion: req.body?.curriculumVersion,
      note: req.body?.note,
    });
    return res.json({ ok: true, version, validation, vtid: VTID });
  } catch (err) {
    if (err instanceof ChecklistValidationError) {
      return res.status(422).json({ ok: false, error: 'validation_failed', validation: err.result, vtid: VTID });
    }
    return fail(res, err, 'publish_failed');
  }
});

router.post('/rollback', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  if (!req.body?.versionId) {
    return res.status(400).json({ ok: false, error: 'missing_version_id', vtid: VTID });
  }
  try {
    const version = await rollbackChecklist(c, req.identity!.user_id, req.body.versionId, {
      curriculumVersion: req.body?.curriculumVersion,
    });
    return res.json({ ok: true, version, vtid: VTID });
  } catch (err: any) {
    if (err?.message === 'version_not_found') {
      return res.status(404).json({ ok: false, error: 'version_not_found', vtid: VTID });
    }
    return fail(res, err, 'rollback_failed');
  }
});

router.get('/export', async (req: AuthenticatedRequest, res: Response) => {
  const c = client(res);
  if (!c) return;
  try {
    const topics = await exportChecklist(c, (req.query.curriculumVersion as string) || 'v2');
    return res.json({ ok: true, curriculumVersion: (req.query.curriculumVersion as string) || 'v2', topics, vtid: VTID });
  } catch (err) {
    return fail(res, err, 'export_failed');
  }
});

export default router;
