import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:user_id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ ok: true, data: { user_id: req.params.user_id } });
});

export default router;