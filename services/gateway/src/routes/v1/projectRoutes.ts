import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

const ProjectParamsSchema = z.object({
  projectId: z.string().min(1),
});

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  const parsed = ProjectParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid parameters' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { project_id: parsed.data.projectId } });
});

export default router;