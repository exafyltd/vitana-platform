import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Mitigate CVE-2024-4068 (ReDoS in path-to-regexp)
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ ok: true, data: { users: [] } });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ ok: true, data: { user_id: req.params.userId } });
});

export default router;