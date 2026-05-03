import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.userId });
});

router.put('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ updated: true });
});

export default router;