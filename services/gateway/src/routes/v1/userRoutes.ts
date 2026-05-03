import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ users: [] });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ userId: req.params.userId, type: 'user' });
});

router.get('/:userId/settings/:settingId', (req: Request, res: Response) => {
  res.json({ userId: req.params.userId, settingId: req.params.settingId });
});

export default router;