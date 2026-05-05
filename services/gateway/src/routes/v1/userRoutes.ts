import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { user: req.params.userId } });
});

export default router;