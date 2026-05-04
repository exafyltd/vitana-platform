import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, profile: {} });
});

export default router;