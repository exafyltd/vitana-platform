import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limiting middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId });
});

router.get('/:userId/settings', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, settings: {} });
});

export default router;