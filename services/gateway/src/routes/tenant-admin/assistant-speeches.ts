/**
 * Phase 1: Tenant Assistant Speeches API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/assistant/speeches
 *
 * Endpoints:
 *   GET    /                  — List all registered speeches with effective text
 *   GET    /:speechKey        — Single speech (default + tenant override)
 *   PUT    /:speechKey        — Upsert tenant override { text }
 *   DELETE /:speechKey        — Clear tenant override; returns effective (= default)
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import {
  isValidSpeechKey,
  SpeechKey,
  getSpeech,
  listSpeeches,
  upsertTenantSpeech,
  resetTenantSpeech,
} from '../../services/assistant-speeches/service';

const router = Router({ mergeParams: true });

// GET / — list all speeches
router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.params.tenantId as string) || (req as any).targetTenantId;
    const speeches = await listSpeeches(tenantId);
    return res.json({ speeches });
  } catch (err: any) {
    console.error('[ASSISTANT-SPEECHES] List error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /:speechKey — single speech detail
router.get('/:speechKey', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.params.tenantId as string) || (req as any).targetTenantId;
    const speechKey = req.params.speechKey;

    if (!isValidSpeechKey(speechKey)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SPEECH_KEY' });
    }

    const speech = await getSpeech(speechKey as SpeechKey, tenantId);
    if (!speech) {
      return res.status(404).json({ ok: false, error: 'SPEECH_NOT_FOUND' });
    }
    return res.json(speech);
  } catch (err: any) {
    console.error('[ASSISTANT-SPEECHES] Get error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// PUT /:speechKey — upsert tenant override
router.put('/:speechKey', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.params.tenantId as string) || (req as any).targetTenantId;
    const speechKey = req.params.speechKey;

    if (!isValidSpeechKey(speechKey)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SPEECH_KEY' });
    }

    const { text } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'EMPTY_TEXT' });
    }

    const result = await upsertTenantSpeech(
      tenantId,
      speechKey as SpeechKey,
      text,
      req.identity!.user_id
    );

    if (!result.ok || !result.speech) {
      const status = result.error === 'EMPTY_TEXT' ? 400 : 500;
      return res.status(status).json({ ok: false, error: result.error });
    }

    return res.json(result.speech);
  } catch (err: any) {
    console.error('[ASSISTANT-SPEECHES] Update error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// DELETE /:speechKey — clear tenant override
router.delete('/:speechKey', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.params.tenantId as string) || (req as any).targetTenantId;
    const speechKey = req.params.speechKey;

    if (!isValidSpeechKey(speechKey)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SPEECH_KEY' });
    }

    const result = await resetTenantSpeech(
      tenantId,
      speechKey as SpeechKey,
      req.identity!.user_id
    );

    if (!result.ok || !result.speech) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    return res.json(result.speech);
  } catch (err: any) {
    console.error('[ASSISTANT-SPEECHES] Delete error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
