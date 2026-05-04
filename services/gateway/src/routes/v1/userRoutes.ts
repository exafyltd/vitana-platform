import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the param limit middleware to mitigate CVE (ReDoS in path-to-regexp)
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, profile: true });
});

export default router;