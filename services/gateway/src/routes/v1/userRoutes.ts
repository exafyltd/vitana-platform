import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, name: 'User' });
});

router.get('/:userId/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, settingId: req.params.settingId });
});

export default router;