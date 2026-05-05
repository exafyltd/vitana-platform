import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply CVE mitigation middleware to prevent ReDoS via path-to-regexp
router.use(limitPathParams());

router.get('/', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: [] });
});

router.get('/:userId', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;