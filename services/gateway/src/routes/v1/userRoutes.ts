import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { userId: req.params.id } });
});

export default router;