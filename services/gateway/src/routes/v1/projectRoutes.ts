import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply CVE mitigation middleware to prevent ReDoS via path-to-regexp
router.use(limitPathParams());

router.get('/', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: [] });
});

router.get('/:projectId', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;