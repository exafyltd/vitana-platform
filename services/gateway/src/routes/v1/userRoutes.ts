import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply middleware to mitigate CVE-2024-28176 (ReDoS in path-to-regexp)
router.use(limitPathParams(5, 200));

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { id: req.params.id } });
});

router.get('/:id/profile/:profileId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { id: req.params.id, profileId: req.params.profileId } });
});

export default router;