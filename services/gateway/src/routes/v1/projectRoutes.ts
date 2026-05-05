import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Applied globally for the router context as specified
router.use(limitPathParams());

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { projects: [] } });
});

// Applied locally to ensure req.params is fully populated during Express routing phase
router.get('/:projectId', requireAuth, limitPathParams(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

router.get('/:projectId/resources/:resourceId', requireAuth, limitPathParams(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({
    ok: true,
    data: {
      project_id: req.params.projectId,
      resource_id: req.params.resourceId
    }
  });
});

export default router;