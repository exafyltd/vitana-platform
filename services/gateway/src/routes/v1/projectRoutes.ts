import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply mitigation to prevent ReDoS attacks via excessive path parameters
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({
    ok: true,
    data: {
      project_id: req.params.projectId
    }
  });
});

router.get('/:projectId/resources/:resourceId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({
    ok: true,
    data: {
      project_id: req.params.projectId,
      resource_id: req.params.resourceId
    }
  });
});

export default router;