import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', requireAuth, (req: Request, res: Response) => {
  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;