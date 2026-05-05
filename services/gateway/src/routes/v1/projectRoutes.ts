import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:project_id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ ok: true, data: { project_id: req.params.project_id } });
});

export default router;